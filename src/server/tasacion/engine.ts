import type { BreakdownItem, TasacionInput, TasacionResult, UbicacionInfo } from '~/types';
import { matchBarrio, valorCochera } from './barrios';
import {
  BAULERA_M2_DEFAULT,
  COEF_CALIDAD,
  COEF_ESTRENAR,
  COEF_SUPERFICIE,
  COEF_UBICACION,
  ESCALA_TABLE,
  FACTOR_EDIFICIO,
  VIDA_UTIL_ANIOS,
  coefAmenities,
  coefPiso,
  interpolate,
  rossHeideckeK,
} from './constants';
import config from './data/config-mercado.json';
import { derivarMejoras } from './mejoras';

export class TasacionInputError extends Error {}

const MAX_M2 = 1000;
const MAX_ANTIGUEDAD = 120;

function round100(v: number): number {
  return Math.round(v / 100) * 100;
}

/** Motor de tasación: código puro, cero LLM. Cada paso queda trazado en el breakdown. */
export function tasar(input: TasacionInput, geo: UbicacionInfo | null = null): TasacionResult {
  if (input.tipoPropiedad !== 'departamento') {
    throw new TasacionInputError(
      'La tasación v1 está calibrada solo para departamentos (la tabla de valores m² es de departamentos). Casas y PH tienen una dinámica de precios distinta.',
    );
  }
  if (!input.m2Cubiertos || input.m2Cubiertos <= 0) {
    throw new TasacionInputError('No pude determinar los m² cubiertos del inmueble — son imprescindibles para tasar.');
  }

  const supuestos: string[] = [];
  const breakdown: BreakdownItem[] = [];

  // ── 1. Superficie homogeneizada ──────────────────────────────────────────
  let m2Cub = input.m2Cubiertos;
  if (m2Cub > MAX_M2) {
    m2Cub = MAX_M2;
    supuestos.push(`m² cubiertos acotados a ${MAX_M2}`);
  }
  const supHom =
    m2Cub * COEF_SUPERFICIE.cubierta +
    (input.m2Semicubiertos ?? 0) * COEF_SUPERFICIE.semicubierta +
    (input.m2Balcon ?? 0) * COEF_SUPERFICIE.balcon +
    (input.m2Descubiertos ?? 0) * COEF_SUPERFICIE.descubierta +
    (input.tieneBaulera ? BAULERA_M2_DEFAULT * COEF_SUPERFICIE.baulera : 0);
  breakdown.push({
    concepto: 'Superficie homogeneizada',
    valor: `${supHom.toFixed(1)} m²`,
    efecto: `cub ${m2Cub} ×1.0 · semi ${input.m2Semicubiertos ?? 0} ×0.5 · balcón ${input.m2Balcon ?? 0} ×0.33 · desc ${input.m2Descubiertos ?? 0} ×0.2${input.tieneBaulera ? ' · baulera' : ''}`,
  });

  // ── 2. Precio base del barrio ────────────────────────────────────────────
  const barrio = matchBarrio(input.barrio);
  if (barrio.fallback) {
    supuestos.push(
      input.barrio
        ? `barrio "${input.barrio}" sin datos propios — se usó el promedio CABA (USD ${barrio.usdM2}/m²)`
        : `sin barrio — se usó el promedio CABA (USD ${barrio.usdM2}/m²)`,
    );
  }
  breakdown.push({
    concepto: `Valor m² publicado (${barrio.barrioUsado})`,
    valor: `USD ${barrio.usdM2}/m²`,
    efecto: `${barrio.fuente}, ${barrio.fecha}`,
  });

  // ── 2b. Micro-zona (patrón espacial histórico, ver micro-index.json) ─────
  let usdM2Base = barrio.usdM2;
  if (geo) {
    if (geo.avisos > 0) {
      usdM2Base = barrio.usdM2 * geo.multiplicador;
      breakdown.push({
        concepto: `Micro-zona (${geo.direccionNormalizada})`,
        valor: `×${geo.multiplicador.toFixed(2)}`,
        efecto: `${geo.avisos} avisos históricos (GCBA, patrón espacial relativo)${geo.smoothed ? ' · suavizado por celdas vecinas sin cruzar barreras' : ''}`,
      });
    } else {
      supuestos.push('micro-zona sin datos históricos suficientes en la celda — se usó la media del barrio');
      breakdown.push({
        concepto: `Micro-zona (${geo.direccionNormalizada})`,
        valor: '×1.00',
        efecto: 'sin datos históricos suficientes en la celda',
      });
    }
  } else if (input.direccion) {
    supuestos.push(`la dirección "${input.direccion}" no se pudo geocodificar — tasación a nivel barrio`);
  }

  // ── 3. Coeficientes hedónicos ────────────────────────────────────────────
  if (input.piso !== null && input.piso > 0 && input.tieneAscensor === null) {
    supuestos.push('se asumió edificio con ascensor');
  }
  const cPiso = coefPiso(input.piso, input.tieneAscensor);
  if (input.piso === null) supuestos.push('piso no informado — coeficiente neutro');
  breakdown.push({
    concepto: `Coef. piso${input.piso !== null ? ` (${input.piso === 0 ? 'PB' : `${input.piso}°`}${input.tieneAscensor === false ? ', sin ascensor' : ''})` : ''}`,
    valor: `×${cPiso.toFixed(2)}`,
  });

  const cUbic = input.ubicacionPlanta ? COEF_UBICACION[input.ubicacionPlanta] : 1.0;
  if (!input.ubicacionPlanta) supuestos.push('ubicación en planta no informada — coeficiente neutro');
  breakdown.push({
    concepto: `Coef. ubicación (${input.ubicacionPlanta ?? 'desconocida'})`,
    valor: `×${cUbic.toFixed(2)}`,
  });

  const cCalidad = input.categoriaConstructiva ? COEF_CALIDAD[input.categoriaConstructiva] : 1.0;
  if (!input.categoriaConstructiva) supuestos.push('categoría constructiva no informada — coeficiente neutro');
  breakdown.push({
    concepto: `Coef. calidad (${input.categoriaConstructiva ?? 'desconocida'})`,
    valor: `×${cCalidad.toFixed(2)}`,
  });

  const cEscala = interpolate(ESCALA_TABLE, supHom);
  breakdown.push({ concepto: 'Coef. escala por superficie', valor: `×${cEscala.toFixed(2)}` });

  const cAmen = coefAmenities(input.amenities.length);
  breakdown.push({
    concepto: `Coef. amenities (${input.amenities.length ? input.amenities.join(', ') : 'sin amenities'})`,
    valor: `×${cAmen.toFixed(2)}`,
  });

  const precioAjustado = usdM2Base * cPiso * cUbic * cCalidad * cEscala * cAmen;

  // ── 4. Publicado → cierre ────────────────────────────────────────────────
  breakdown.push({
    concepto: 'Coef. de oferta (publicado → cierre)',
    valor: `×${config.co}`,
    efecto: `brecha ${config.brecha} — ${config.fuente}, ${config.fecha}`,
  });
  const valorMCM = precioAjustado * config.co * supHom;
  breakdown.push({ concepto: 'Valor método comparativo', valor: `USD ${round100(valorMCM).toLocaleString('es-AR')}` });

  // ── 5. Cochera ───────────────────────────────────────────────────────────
  const cochera = input.tieneCochera ? valorCochera(input.barrio) : 0;
  if (input.tieneCochera) {
    breakdown.push({ concepto: 'Cochera', valor: `+USD ${cochera.toLocaleString('es-AR')}` });
  }

  // ── 6. Antigüedad / estado (Ross-Heidecke sobre componente construcción) ──
  let antiguedad: number;
  if (input.antiguedadAnios === null) {
    antiguedad = 25;
    supuestos.push('antigüedad no informada — se asumieron 25 años');
  } else if (input.antiguedadAnios > MAX_ANTIGUEDAD) {
    antiguedad = MAX_ANTIGUEDAD;
    supuestos.push(`antigüedad acotada a ${MAX_ANTIGUEDAD} años`);
  } else {
    antiguedad = input.antiguedadAnios;
  }
  let estado: number;
  if (input.estadoConservacion === null) {
    estado = 2.5;
    supuestos.push('estado no informado — se asumió "normal" (2,5)');
  } else {
    estado = input.estadoConservacion;
  }
  const k = rossHeideckeK((antiguedad / VIDA_UTIL_ANIOS) * 100, estado);
  const cAntiguedad = 1 - k * FACTOR_EDIFICIO;
  breakdown.push({
    concepto: `Coef. antigüedad/estado (Ross-Heidecke: ${antiguedad} años, estado ${estado})`,
    valor: `×${cAntiguedad.toFixed(3)}`,
    efecto: `K=${k.toFixed(3)} aplicado al ${FACTOR_EDIFICIO * 100}% del valor (la construcción; el suelo no deprecia)`,
  });

  // ── 7. A estrenar ────────────────────────────────────────────────────────
  const cEstrenar = input.aEstrenar ? COEF_ESTRENAR : 1.0;
  if (input.aEstrenar) {
    supuestos.push(`premio "a estrenar" +${Math.round((COEF_ESTRENAR - 1) * 100)}% [supuesto de mercado]`);
    breakdown.push({ concepto: 'A estrenar', valor: `×${COEF_ESTRENAR}` });
  }

  const valor = (valorMCM + cochera) * cAntiguedad * cEstrenar;

  // ── 8. Confianza ─────────────────────────────────────────────────────────
  let score = 100;
  if (input.antiguedadAnios === null) score -= 10;
  if (input.estadoConservacion === null) score -= 10;
  if (input.piso === null) score -= 5;
  if (!input.ubicacionPlanta) score -= 5;
  if (barrio.fallback) score -= 50;
  if (!input.direccion) score -= 10;
  if (input.direccion && !geo) score -= 10;
  if (geo && geo.avisos === 0) score -= 5;
  const confianza = score >= 85 ? 'alta' : score >= 60 ? 'media' : 'baja';

  return {
    valorEstimadoUsd: round100(valor),
    rangoUsd: [round100(valor * 0.85), round100(valor * 1.15)],
    confianza,
    superficieHomogeneizada: Math.round(supHom * 100) / 100,
    breakdown,
    supuestos,
    fuentePrecios: {
      fuente: barrio.fuente,
      fecha: barrio.fecha,
      barrioUsado: barrio.barrioUsado,
      fallback: barrio.fallback,
    },
    ubicacion: geo,
    mejoras: derivarMejoras(input, geo),
  };
}
