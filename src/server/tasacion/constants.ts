import type { CategoriaConstructiva, UbicacionPlanta } from '~/types';

// ═══ Coeficientes estables de la práctica de tasación argentina ═══
// Fuentes: Norma TTN 3.1 (método comparativo), TTN 4.1 (método del costo / Ross-Heidecke),
// tablas de práctica profesional (El Tasador Pampeano). Ver spec 2026-06-12.

/** Homogeneización de superficies (m² ponderado). */
export const COEF_SUPERFICIE = {
  cubierta: 1.0,
  semicubierta: 0.5,
  balcon: 0.33,
  descubierta: 0.2,
  baulera: 0.35,
} as const;

/** m² asumidos para una baulera cuando el aviso no da metraje. */
export const BAULERA_M2_DEFAULT = 4;

/** Coeficiente por piso. Base = 3° piso con ascensor (1.0). */
export function coefPiso(piso: number | null, tieneAscensor: boolean | null): number {
  if (piso === null) return 1.0;
  const p = Math.max(0, Math.min(30, Math.round(piso)));
  if (tieneAscensor === false) {
    // sin ascensor: PB vale base y cada piso resta 5%, con piso en 0.70
    return Math.max(0.7, 1.0 - 0.05 * p);
  }
  // con ascensor (null se asume ascensor: edificios CABA)
  if (p === 0) return 0.9;
  if (p === 1) return 0.95;
  if (p === 2) return 0.98;
  return Math.min(1.15, 1.0 + 0.02 * (p - 3));
}

export const COEF_UBICACION: Record<UbicacionPlanta, number> = {
  frente: 1.0,
  lateral: 0.94,
  contrafrente: 0.85,
  interno: 0.8,
};

export const COEF_CALIDAD: Record<CategoriaConstructiva, number> = {
  economica: 0.9,
  estandar: 1.0,
  buena: 1.1,
  buena_servicios: 1.2,
  premium: 1.35,
};

/** Coeficiente de escala: deptos chicos valen más por m². [supHom, coef] — interpolación lineal. */
export const ESCALA_TABLE: [number, number][] = [
  [25, 1.35],
  [40, 1.25],
  [50, 1.15],
  [60, 1.08],
  [75, 1.02],
  [85, 1.0],
  [110, 0.96],
  [150, 0.9],
];

export function coefAmenities(cantidad: number): number {
  if (cantidad === 0) return 1.0;
  return cantidad <= 2 ? 1.05 : 1.1;
}

/** Interpolación lineal sobre una tabla [x, y] ordenada por x; clampea en los extremos. */
export function interpolate(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i - 1];
    const [x2, y2] = table[i];
    if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

// ═══ Ross-Heidecke (Norma TTN 4.1) ═══
export const VIDA_UTIL_ANIOS = 100; // hormigón armado, edificios de altura CABA
/** Proporción del valor total que representa la construcción (el suelo no deprecia). [SUPUESTO documentado] */
export const FACTOR_EDIFICIO = 0.45;
/** Premio "a estrenar" sobre el promedio de mercado usado. [SUPUESTO documentado] */
export const COEF_ESTRENAR = 1.1;

/** Estados Heidecke de las columnas de la tabla K. */
const RH_ESTADOS = [1.0, 2.0, 2.5, 3.0, 3.5];
/** Filas: % de vida transcurrida 0..100 (paso 10). Valores representativos de la tabla TTN 4.1. */
const RH_TABLE: number[][] = [
  [0.0, 0.0, 0.0, 0.0, 0.0],
  [0.032, 0.067, 0.1, 0.132, 0.171],
  [0.052, 0.114, 0.154, 0.21, 0.289],
  [0.083, 0.163, 0.22, 0.316, 0.43],
  [0.117, 0.221, 0.306, 0.44, 0.572],
  [0.16, 0.293, 0.408, 0.559, 0.693],
  [0.215, 0.382, 0.516, 0.667, 0.792],
  [0.293, 0.49, 0.638, 0.773, 0.872],
  [0.39, 0.617, 0.752, 0.858, 0.932],
  [0.519, 0.763, 0.869, 0.93, 0.967],
  [1.0, 1.0, 1.0, 1.0, 1.0],
];

/** K de depreciación Ross-Heidecke con interpolación bilineal (filas %vida, columnas estado). */
export function rossHeideckeK(pctVida: number, estado: number): number {
  const pct = Math.max(0, Math.min(100, pctVida));
  const est = Math.max(RH_ESTADOS[0], Math.min(RH_ESTADOS[RH_ESTADOS.length - 1], estado));

  const row = pct / 10;
  const r0 = Math.floor(row);
  const r1 = Math.min(10, r0 + 1);
  const rt = row - r0;

  let c1 = RH_ESTADOS.length - 1;
  for (let i = 1; i < RH_ESTADOS.length; i++) {
    if (est <= RH_ESTADOS[i]) {
      c1 = i;
      break;
    }
  }
  const c0 = c1 - 1 < 0 ? 0 : c1 - 1;
  const span = RH_ESTADOS[c1] - RH_ESTADOS[c0];
  const ct = span === 0 ? 0 : (est - RH_ESTADOS[c0]) / span;

  const kr0 = RH_TABLE[r0][c0] + (RH_TABLE[r0][c1] - RH_TABLE[r0][c0]) * ct;
  const kr1 = RH_TABLE[r1][c0] + (RH_TABLE[r1][c1] - RH_TABLE[r1][c0]) * ct;
  return kr0 + (kr1 - kr0) * rt;
}
