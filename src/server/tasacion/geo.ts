import index from './data/micro-index.json';
import { cellKey } from './geo-build';

const USIG_URL = 'https://servicios.usig.buenosaires.gob.ar/normalizar/';
const USIG_TIMEOUT_MS = 8000;

export interface GeoPoint {
  lat: number;
  lon: number;
  direccionNormalizada: string;
}

/**
 * Geocoder oficial del GCBA (gratis, sin key). OJO: la respuesta trae x=LONGITUD, y=LATITUD.
 * Null ante cualquier fallo — la tasación degrada a nivel barrio, nunca bloquea.
 */
export async function geocodeUSIG(direccion: string): Promise<GeoPoint | null> {
  try {
    const url = `${USIG_URL}?direccion=${encodeURIComponent(`${direccion}, caba`)}&geocodificar=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(USIG_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      direccionesNormalizadas?: { direccion?: string; coordenadas?: { x?: string | number; y?: string | number } }[];
    };
    const d = data.direccionesNormalizadas?.[0];
    if (!d?.coordenadas) return null;
    const lon = Number(d.coordenadas.x);
    const lat = Number(d.coordenadas.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, direccionNormalizada: d.direccion ?? direccion };
  } catch {
    return null;
  }
}

export interface MicroCell {
  multiplicador: number;
  avisos: number;
  smoothed: boolean;
}

// El JSON importado tipa cada celda como number[]; el script de build garantiza tuplas [mult, avisos, smoothed01].
const CELLS = index.cells as unknown as Record<string, [number, number, number]>;

/** Lookup O(1) del multiplicador de micro-zona. Null si la celda no tiene datos. */
export function microLookup(lat: number, lon: number): MicroCell | null {
  const c = CELLS[cellKey(lat, lon)];
  return c ? { multiplicador: c[0], avisos: c[1], smoothed: c[2] === 1 } : null;
}
