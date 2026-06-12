export type UbicacionPlanta = 'frente' | 'lateral' | 'contrafrente' | 'interno';
export type CategoriaConstructiva = 'economica' | 'estandar' | 'buena' | 'buena_servicios' | 'premium';

/** Atributos extraídos de la descripción por el LLM. Campo ausente en el texto = null (no se inventa). */
export interface TasacionInput {
  tipoPropiedad: 'departamento' | 'casa' | 'ph';
  barrio: string | null;
  m2Cubiertos: number | null;
  m2Semicubiertos: number | null;
  m2Balcon: number | null;
  m2Descubiertos: number | null;
  piso: number | null; // 0 = planta baja
  tieneAscensor: boolean | null;
  ubicacionPlanta: UbicacionPlanta | null;
  antiguedadAnios: number | null;
  /** Escala Heidecke: 1.0 excelente · 2.0 bueno · 2.5 normal · 3.0 regular · 3.5 malo · 4.0 muy malo */
  estadoConservacion: number | null;
  tieneCochera: boolean;
  tieneBaulera: boolean;
  amenities: string[];
  categoriaConstructiva: CategoriaConstructiva | null;
  aEstrenar: boolean;
}

export interface BreakdownItem {
  concepto: string; // "Superficie homogeneizada", "Coef. piso (5°, c/ascensor)", ...
  valor: string; // "77.6 m²", "×1.04", "USD 3.403/m²", ...
  efecto?: string; // opcional: efecto acumulado en USD
}

export interface TasacionResult {
  valorEstimadoUsd: number; // redondeado a centenas
  rangoUsd: [number, number]; // ±15%
  confianza: 'alta' | 'media' | 'baja';
  superficieHomogeneizada: number;
  breakdown: BreakdownItem[];
  supuestos: string[]; // supuestos/defaults aplicados, en lenguaje humano
  fuentePrecios: { fuente: string; fecha: string; barrioUsado: string; fallback: boolean };
}
