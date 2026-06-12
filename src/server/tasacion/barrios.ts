import cocheras from './data/cocheras.json';
import precios from './data/precios-barrio.json';

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ');
}

/** Alias y sub-barrios → clave de la tabla (claves ya normalizadas). */
const ALIAS: Record<string, string> = {
  lugano: 'villa lugano',
  'barrio norte': 'recoleta',
  'palermo soho': 'palermo',
  'palermo hollywood': 'palermo',
  'palermo chico': 'palermo',
  'palermo viejo': 'palermo',
  'las canitas': 'palermo',
  pompeya: 'nueva pompeya',
};

export interface BarrioMatch {
  barrioUsado: string; // clave usada en la tabla (o "CABA promedio")
  usdM2: number;
  fuente: string;
  fecha: string;
  fallback: boolean;
}

const BARRIOS = precios.barrios as Record<string, { usdM2: number; fuente: string; fecha: string }>;

export function matchBarrio(raw: string | null): BarrioMatch {
  const fb: BarrioMatch = { barrioUsado: 'CABA promedio', ...precios.fallback, fallback: true };
  if (!raw) return fb;
  const n = normalize(raw);
  const key = BARRIOS[n] ? n : ALIAS[n] && BARRIOS[ALIAS[n]] ? ALIAS[n] : undefined;
  if (key) return { barrioUsado: key, ...BARRIOS[key], fallback: false };
  // sub-zona que contiene un barrio conocido ("palermo nuevo" → "palermo")
  for (const k of Object.keys(BARRIOS)) {
    if (n.startsWith(k) || n.includes(k)) return { barrioUsado: k, ...BARRIOS[k], fallback: false };
  }
  return fb;
}

const COCHERAS = cocheras.barrios as Record<string, number>;

export function valorCochera(raw: string | null): number {
  if (!raw) return cocheras.default;
  const n = normalize(raw);
  const key = COCHERAS[n] ? n : ALIAS[n] && COCHERAS[ALIAS[n]] ? ALIAS[n] : undefined;
  if (key) return COCHERAS[key];
  for (const k of Object.keys(COCHERAS)) {
    if (n.startsWith(k) || n.includes(k)) return COCHERAS[k];
  }
  return cocheras.default;
}
