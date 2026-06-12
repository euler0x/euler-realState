// Helpers puros para construir el micro-índice geográfico (usados por scripts/build-geo-index.ts).
// Todo determinístico y testeable: el "radio inteligente" es un BFS sobre celdas vecinas cuyas
// aristas se bloquean si el segmento entre centros cruza una barrera (vía de tren / autopista).

export const D_LAT = 0.0015; // ~166 m N-S
export const D_LON = 0.0018; // ~166 m E-O a latitud -34.6 (corrección cos)
export const REL_CLAMP: [number, number] = [0.4, 2.5];
export const MULT_CLAMP: [number, number] = [0.7, 1.4];

export interface Point {
  lat: number;
  lon: number;
}
export type Polyline = Point[];

export interface RawListing {
  lat: number;
  lon: number;
  usdM2: number;
  barrio: string;
  anio: number;
}

export interface RelPoint {
  lat: number;
  lon: number;
  rel: number;
}

export interface CellValue {
  multiplier: number;
  count: number;
  smoothed: boolean;
}

export function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / D_LAT)}_${Math.floor(lon / D_LON)}`;
}

export function cellCenter(key: string): Point {
  const [i, j] = key.split('_').map(Number);
  return { lat: (i + 0.5) * D_LAT, lon: (j + 0.5) * D_LON };
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, v));
}

/** rel = usdM2 / mediana(usdM2 del mismo barrio en el mismo año) — elimina inflación y drift. */
export function computeRels(listings: RawListing[]): RelPoint[] {
  const groups = new Map<string, number[]>();
  for (const l of listings) {
    const g = `${l.barrio}|${l.anio}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(l.usdM2);
  }
  const medians = new Map<string, number>();
  for (const [g, vals] of groups) medians.set(g, median(vals));
  return listings.map((l) => ({
    lat: l.lat,
    lon: l.lon,
    rel: clamp(l.usdM2 / medians.get(`${l.barrio}|${l.anio}`)!, REL_CLAMP),
  }));
}

/** Intersección de segmentos (método de orientaciones, incluye casos colineales/toque). */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o = (a: Point, b: Point, c: Point) => {
    const v = (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
    return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0;
  };
  const onSeg = (a: Point, b: Point, c: Point) =>
    Math.min(a.lat, b.lat) - 1e-12 <= c.lat &&
    c.lat <= Math.max(a.lat, b.lat) + 1e-12 &&
    Math.min(a.lon, b.lon) - 1e-12 <= c.lon &&
    c.lon <= Math.max(a.lon, b.lon) + 1e-12;
  const o1 = o(p1, p2, p3);
  const o2 = o(p1, p2, p4);
  const o3 = o(p3, p4, p1);
  const o4 = o(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p2, p3)) return true;
  if (o2 === 0 && onSeg(p1, p2, p4)) return true;
  if (o3 === 0 && onSeg(p3, p4, p1)) return true;
  if (o4 === 0 && onSeg(p3, p4, p2)) return true;
  return false;
}

export function segmentCrossesBarriers(a: Point, b: Point, barriers: Polyline[]): boolean {
  for (const line of barriers) {
    for (let i = 1; i < line.length; i++) {
      if (segmentsIntersect(a, b, line[i - 1], line[i])) return true;
    }
  }
  return false;
}

export function buildCells(rels: RelPoint[]): Map<string, number[]> {
  const cells = new Map<string, number[]>();
  for (const r of rels) {
    const k = cellKey(r.lat, r.lon);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(r.rel);
  }
  return cells;
}

const NEIGHBORS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
] as const;

export interface SmoothOptions {
  minSamples: number;
  maxDepth: number;
}

/**
 * Suavizado con barreras: una celda con pocas muestras junta datos de vecinas vía BFS,
 * pero una arista entre celdas se bloquea si el segmento entre centros cruza una barrera.
 * Así "el otro lado de la vía" nunca contamina el multiplicador.
 */
export function smoothCells(
  cells: Map<string, number[]>,
  barriers: Polyline[],
  opts: SmoothOptions,
): Map<string, CellValue> {
  const out = new Map<string, CellValue>();
  for (const [key, values] of cells) {
    if (values.length >= opts.minSamples) {
      out.set(key, { multiplier: clamp(median(values), MULT_CLAMP), count: values.length, smoothed: false });
      continue;
    }
    // BFS por capas respetando barreras
    const pool = [...values];
    const visited = new Set([key]);
    let frontier = [key];
    for (let depth = 0; depth < opts.maxDepth && pool.length < opts.minSamples; depth++) {
      const next: string[] = [];
      for (const k of frontier) {
        const [i, j] = k.split('_').map(Number);
        const from = cellCenter(k);
        for (const [di, dj] of NEIGHBORS) {
          const nk = `${i + di}_${j + dj}`;
          if (visited.has(nk)) continue;
          const to = cellCenter(nk);
          if (segmentCrossesBarriers(from, to, barriers)) continue;
          visited.add(nk);
          next.push(nk);
          const nv = cells.get(nk);
          if (nv) pool.push(...nv);
        }
      }
      frontier = next;
    }
    if (pool.length >= opts.minSamples) {
      out.set(key, { multiplier: clamp(median(pool), MULT_CLAMP), count: pool.length, smoothed: true });
    }
    // si ni así llega → la celda queda fuera (runtime cae a ×1.0)
  }
  return out;
}
