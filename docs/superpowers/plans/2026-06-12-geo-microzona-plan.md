# Geo micro-zona + guía de confianza + guardar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (1) Micro-índice geográfico de CABA construido UNA vez en build-time (datos GCBA 2014-2020, grilla ~166m, suavizado BFS que respeta barreras FFCC/autopistas) con lookup O(1) en runtime vía geocoder USIG; (2) checklist "para mejorar esta tasación" derivada de los campos faltantes; (3) guardar tasación: historial SQLite + export PNG con mapa Leaflet/OSM.

**Architecture:** `geo-build.ts` (helpers puros testeables) + `scripts/build-geo-index.ts` (descarga y genera `micro-index.json`, se corre una vez y el output se commitea) → `geo.ts` runtime (geocodeUSIG + microLookup) → motor v2 (`tasar(input, geo)` aplica multiplicador de micro-zona, confianza v2, `mejoras`) → rutas + UI (mapa, panel mejoras, guardar/historial/export). Spec: `docs/superpowers/specs/2026-06-12-geo-microzona-design.md`.

**Tech Stack:** Next.js 15, TypeScript, MUI, better-sqlite3, leaflet + html-to-image (nuevas, MIT sin keys), csv-parse (dev, solo script). Branch: `feat/geo-microzona`.

**Costo LLM:** cero adicional (todo lo geo es código + datos). Solo el smoke final (Task 9) consume cuota (~10k, 1 extracción).

---

### Task 1: Helpers geométricos puros (TDD)

**Files:**
- Create: `src/server/tasacion/geo-build.ts`
- Test: `src/server/tasacion/__tests__/geo-build.test.ts`

- [ ] **Step 1: Test que falla** — `src/server/tasacion/__tests__/geo-build.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import {
  cellKey,
  cellCenter,
  median,
  computeRels,
  segmentsIntersect,
  segmentCrossesBarriers,
  buildCells,
  smoothCells,
  type Polyline,
} from '../geo-build';

describe('cellKey / cellCenter', () => {
  it('asigna celdas estables y center es el centro de la celda', () => {
    const k = cellKey(-34.6, -58.4);
    expect(k).toBe(cellKey(-34.6001, -58.4001)); // misma celda (~166m)
    const c = cellCenter(k);
    expect(cellKey(c.lat, c.lon)).toBe(k);
  });
});

describe('median', () => {
  it('mediana de impares, pares y único', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
});

describe('computeRels', () => {
  it('rel = precio / mediana de su (barrio, año), clampeado a [0.4, 2.5]', () => {
    const listings = [
      { lat: 1, lon: 1, usdM2: 1000, barrio: 'a', anio: 2019 },
      { lat: 1, lon: 1, usdM2: 2000, barrio: 'a', anio: 2019 },
      { lat: 1, lon: 1, usdM2: 3000, barrio: 'a', anio: 2019 },
      { lat: 2, lon: 2, usdM2: 99999, barrio: 'a', anio: 2019 }, // outlier → clamp 2.5
    ];
    const rels = computeRels(listings);
    // mediana de [1000,2000,3000,99999] = 2500
    expect(rels[0].rel).toBeCloseTo(0.4); // 1000/2500 = 0.4 (justo en el clamp inferior)
    expect(rels[1].rel).toBeCloseTo(2000 / 2500);
    expect(rels[3].rel).toBeCloseTo(2.5); // clamp superior
  });
  it('barrios/años distintos no se mezclan', () => {
    const rels = computeRels([
      { lat: 1, lon: 1, usdM2: 1000, barrio: 'a', anio: 2018 },
      { lat: 1, lon: 1, usdM2: 4000, barrio: 'b', anio: 2018 },
    ]);
    // cada uno es la mediana de su propio grupo → rel 1.0
    expect(rels[0].rel).toBeCloseTo(1.0);
    expect(rels[1].rel).toBeCloseTo(1.0);
  });
});

describe('segmentsIntersect', () => {
  const p = (lat: number, lon: number) => ({ lat, lon });
  it('detecta cruce en X', () => {
    expect(segmentsIntersect(p(0, -1), p(0, 1), p(-1, 0), p(1, 0))).toBe(true);
  });
  it('paralelos no cruzan', () => {
    expect(segmentsIntersect(p(0, 0), p(0, 1), p(1, 0), p(1, 1))).toBe(false);
  });
  it('segmentos lejanos no cruzan', () => {
    expect(segmentsIntersect(p(0, 0), p(0, 1), p(5, 5), p(6, 6))).toBe(false);
  });
  it('toque en extremo cuenta como cruce', () => {
    expect(segmentsIntersect(p(0, 0), p(2, 2), p(2, 2), p(3, 0))).toBe(true);
  });
  it('segmentCrossesBarriers recorre los tramos de cada polilínea', () => {
    const barrier: Polyline = [p(-1, 0), p(0, 0), p(1, 0)]; // polilínea vertical en lon=0 con vértice
    expect(segmentCrossesBarriers(p(0.5, -0.5), p(0.5, 0.5), [barrier])).toBe(true);
    expect(segmentCrossesBarriers(p(0.5, 0.1), p(0.5, 0.5), [barrier])).toBe(false);
  });
});

describe('smoothCells con barreras — "la vía parte el barrio"', () => {
  // Grilla sintética alrededor de lon=0: lado oeste (lon<0, celda j=-1) rel~1.3 con 11 datos;
  // lado este (celda j=1) rel~0.8 con 9 datos. La celda pobre (j=0, 1 dato) es vecina de AMBAS.
  // Barrera: polilínea vertical en lon=0 — bloquea la arista hacia el oeste.
  const D_LAT = 0.0015;
  const D_LON = 0.0018;
  const west = (i: number) => ({ lat: 0.5 * D_LAT + i * 1e-6, lon: -0.5 * D_LON, rel: 1.3 });
  const east = (i: number) => ({ lat: 0.5 * D_LAT + i * 1e-6, lon: 1.5 * D_LON, rel: 0.8 });
  // celda este adyacente a la barrera, con UN solo dato (insuficiente, minSamples=4)
  const sparse = { lat: 0.5 * D_LAT, lon: 0.5 * D_LON, rel: 0.85 };

  const rels = [
    ...Array.from({ length: 11 }, (_, i) => west(i)),
    ...Array.from({ length: 9 }, (_, i) => east(i)),
    sparse,
  ];
  const barrier: Polyline = [
    { lat: -1, lon: 0 },
    { lat: 1, lon: 0 },
  ];

  it('sin barrera, la celda pobre absorbe datos de ambos lados', () => {
    const cells = buildCells(rels);
    const out = smoothCells(cells, [], { minSamples: 4, maxDepth: 3 });
    const c = out.get(cellKey(sparse.lat, sparse.lon))!;
    expect(c.smoothed).toBe(true);
    // pool = 0.8×9 + 0.85 + 1.3×11 (21 valores) → mediana 1.3 (domina el oeste) → > 0.85
    expect(c.multiplier).toBeGreaterThan(0.85);
  });

  it('con la barrera, solo junta datos de SU lado', () => {
    const cells = buildCells(rels);
    const out = smoothCells(cells, [barrier], { minSamples: 4, maxDepth: 3 });
    const c = out.get(cellKey(sparse.lat, sparse.lon))!;
    expect(c.smoothed).toBe(true);
    expect(c.multiplier).toBeLessThanOrEqual(0.85); // solo lado este (0.8/0.85)
  });

  it('celda con muestras suficientes no se suaviza y clampea a [0.7, 1.4]', () => {
    const dense = Array.from({ length: 6 }, (_, i) => ({ lat: 10 * D_LAT, lon: 10 * D_LON, rel: 2.0 + i * 0.01 }));
    const out = smoothCells(buildCells(dense), [], { minSamples: 4, maxDepth: 3 });
    const c = out.get(cellKey(10 * D_LAT, 10 * D_LON))!;
    expect(c.smoothed).toBe(false);
    expect(c.multiplier).toBe(1.4); // clamp
  });

  it('celda irrecuperable queda fuera del índice', () => {
    const lone = [{ lat: 50 * D_LAT, lon: 50 * D_LON, rel: 1.0 }];
    const out = smoothCells(buildCells(lone), [], { minSamples: 4, maxDepth: 1 });
    expect(out.has(cellKey(50 * D_LAT, 50 * D_LON))).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `pnpm run test:unit -- geo-build` → FAIL.

- [ ] **Step 3: Implementar `src/server/tasacion/geo-build.ts`**:

```ts
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
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
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
```

- [ ] **Step 4:** Run `pnpm run test:unit -- geo-build` → PASS (todos). Los tests fijan el contrato; si algo no da, corregí la implementación.

- [ ] **Step 5: Commit** (FOREGROUND, timeout 420000ms — hooks lentos, no cancelar):

```bash
git add src/server/tasacion/geo-build.ts src/server/tasacion/__tests__/geo-build.test.ts
git commit -m "feat: pure geo helpers (grid, rel index, barrier-aware BFS smoothing)"
```

---

### Task 2: Script de build + GENERAR el índice real

**Files:**
- Create: `scripts/build-geo-index.ts`
- Create (generados por el script y commiteados): `src/server/tasacion/data/micro-index.json`, `src/server/tasacion/data/barreras.geojson`
- Modify: `src/server/tasacion/data/README.md` (sección de regeneración), `.gitignore` (cache de descargas), `package.json` (devDep csv-parse)

- [ ] **Step 1:** `pnpm add -D csv-parse` y agregar a `.gitignore`:

```
# geo build cache (CSVs crudos del GCBA, no se commitean)
scripts/.cache/
```

- [ ] **Step 2: Crear `scripts/build-geo-index.ts`**:

```ts
/* eslint-disable no-console */
// Construye el micro-índice geográfico de CABA. Se corre UNA VEZ (o al refrescar datos):
//   npx tsx scripts/build-geo-index.ts
// Descarga avisos históricos del GCBA (2014-2020) + barreras (FFCC GCBA, autopistas OSM),
// computa el índice relativo con suavizado por barreras y escribe:
//   src/server/tasacion/data/micro-index.json
//   src/server/tasacion/data/barreras.geojson
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import {
  buildCells,
  computeRels,
  smoothCells,
  D_LAT,
  D_LON,
  type Polyline,
  type RawListing,
} from '../src/server/tasacion/geo-build';

const CACHE = path.join(__dirname, '.cache');
const OUT_DIR = path.join(__dirname, '..', 'src', 'server', 'tasacion', 'data');
const YEARS = [2014, 2015, 2016, 2017, 2018, 2019, 2020];
const GCBA_CSV = (y: number) =>
  `https://cdn.buenosaires.gob.ar/datosabiertos/datasets/secretaria-de-desarrollo-urbano/departamentos-venta/departamentos-en-venta-${y}.csv`;
// bbox CABA
const BBOX = { latMin: -34.71, latMax: -34.52, lonMin: -58.55, lonMax: -58.33 };
const MIN_SAMPLES = 8;
const MAX_DEPTH = 3;
const MIN_YEARS = 4;
const MIN_CELLS = 1000;

async function download(url: string, file: string): Promise<string | null> {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest)) return fs.readFileSync(dest, 'utf-8');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      console.warn(`  ✗ ${url} → HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(dest, text);
    return text;
  } catch (e) {
    console.warn(`  ✗ ${url} → ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Lee un campo tolerando variantes de nombre entre años (LATITUD/latitud/lat...). */
function field(row: Record<string, string>, aliases: string[]): string | undefined {
  for (const key of Object.keys(row)) {
    if (aliases.includes(key.toLowerCase().trim())) return row[key];
  }
  return undefined;
}

function parseListings(csv: string, anio: number): RawListing[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<
    string,
    string
  >[];
  const out: RawListing[] = [];
  let rejected = 0;
  for (const row of rows) {
    const lat = Number(field(row, ['latitud', 'lat', 'y']));
    const lon = Number(field(row, ['longitud', 'long', 'lon', 'lng', 'x']));
    const usdM2 = Number(field(row, ['preciousdm', 'precio_usd_m2', 'usdm2', 'preciousdxm2']));
    const m2 = Number(field(row, ['m2cub', 'm2_cub', 'sup_cubierta', 'm2total', 'm2']));
    const barrio = (field(row, ['barrios_1', 'barrio', 'barrios']) ?? '').toLowerCase().trim();
    const ok =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat > BBOX.latMin &&
      lat < BBOX.latMax &&
      lon > BBOX.lonMin &&
      lon < BBOX.lonMax &&
      Number.isFinite(usdM2) &&
      usdM2 > 200 &&
      usdM2 < 20000 &&
      Number.isFinite(m2) &&
      m2 >= 20 &&
      m2 <= 500 &&
      barrio.length > 0;
    if (ok) out.push({ lat, lon, usdM2, barrio, anio });
    else rejected++;
  }
  console.log(`  ${anio}: ${out.length} aceptados, ${rejected} rechazados`);
  return out;
}

/** GeoJSON (LineString/MultiLineString, coords [lon,lat]) → Polyline[] ({lat,lon}). */
function geojsonToPolylines(gj: { features?: { geometry?: { type?: string; coordinates?: unknown } }[] }): Polyline[] {
  const lines: Polyline[] = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g?.coordinates) continue;
    const toLine = (coords: [number, number][]): Polyline => coords.map(([lon, lat]) => ({ lat, lon }));
    if (g.type === 'LineString') lines.push(toLine(g.coordinates as [number, number][]));
    if (g.type === 'MultiLineString') for (const c of g.coordinates as [number, number][][]) lines.push(toLine(c));
  }
  return lines;
}

async function fetchFFCC(): Promise<Polyline[]> {
  // Resource "Red de Ferrocarril (GeoJSON)" del dataset estaciones-ferrocarril (verificado 2026-06-12).
  // La URL del archivo se resuelve desde la API CKAN del portal:
  const api =
    'https://data.buenosaires.gob.ar/api/3/action/package_show?id=estaciones-ferrocarril';
  const meta = await download(api, 'ffcc-meta.json');
  if (!meta) throw new Error('No pude leer los metadatos del dataset de FFCC — abortando (barrera requerida)');
  const pkg = JSON.parse(meta) as { result?: { resources?: { format?: string; name?: string; url?: string }[] } };
  const res = pkg.result?.resources?.find(
    (r) => r.format?.toUpperCase() === 'GEOJSON' && (r.name ?? '').toLowerCase().includes('red'),
  );
  if (!res?.url) throw new Error('No encontré el GeoJSON de la red de FFCC en el dataset — abortando');
  const gj = await download(res.url, 'ffcc.geojson');
  if (!gj) throw new Error('Descarga del GeoJSON de FFCC falló — abortando');
  return geojsonToPolylines(JSON.parse(gj));
}

async function fetchAutopistas(): Promise<Polyline[]> {
  // OSM Overpass: highway=motorway dentro del bbox CABA. Si falla → warning y seguimos solo con FFCC.
  const q = `[out:json][timeout:60];way["highway"="motorway"](${BBOX.latMin},${BBOX.lonMin},${BBOX.latMax},${BBOX.lonMax});out geom;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { elements?: { geometry?: { lat: number; lon: number }[] }[] };
    const lines: Polyline[] = (data.elements ?? [])
      .map((e) => (e.geometry ?? []).map((p) => ({ lat: p.lat, lon: p.lon })))
      .filter((l) => l.length >= 2);
    console.log(`  autopistas OSM: ${lines.length} tramos`);
    return lines;
  } catch (e) {
    console.warn(`  ⚠ Overpass falló (${e instanceof Error ? e.message : e}) — sigo solo con FFCC`);
    return [];
  }
}

async function main() {
  console.log('1/4 Descargando avisos GCBA…');
  const listings: RawListing[] = [];
  let yearsOk = 0;
  for (const y of YEARS) {
    const csv = await download(GCBA_CSV(y), `deptos-${y}.csv`);
    if (!csv) continue;
    listings.push(...parseListings(csv, y));
    yearsOk++;
  }
  if (yearsOk < MIN_YEARS) throw new Error(`Solo ${yearsOk} años descargados (< ${MIN_YEARS}) — abortando`);
  console.log(`  total: ${listings.length} avisos de ${yearsOk} años`);

  console.log('2/4 Descargando barreras…');
  const ffcc = await fetchFFCC();
  console.log(`  FFCC: ${ffcc.length} polilíneas`);
  const autopistas = await fetchAutopistas();
  const barriers = [...ffcc, ...autopistas];

  console.log('3/4 Computando índice…');
  const rels = computeRels(listings);
  const cells = smoothCells(buildCells(rels), barriers, { minSamples: MIN_SAMPLES, maxDepth: MAX_DEPTH });
  if (cells.size < MIN_CELLS) throw new Error(`Índice con ${cells.size} celdas (< ${MIN_CELLS}) — abortando`);

  const mults = [...cells.values()].map((c) => c.multiplier).sort((a, b) => a - b);
  const pct = (p: number) => mults[Math.floor(p * (mults.length - 1))];
  console.log(
    `  celdas: ${cells.size} · multiplicador p5=${pct(0.05).toFixed(2)} p50=${pct(0.5).toFixed(2)} p95=${pct(0.95).toFixed(2)}`,
  );

  console.log('4/4 Escribiendo outputs…');
  const index = {
    meta: {
      fuente: 'GCBA Departamentos en Venta (data.buenosaires.gob.ar), patrón espacial relativo',
      anios: `${YEARS[0]}-${YEARS[YEARS.length - 1]} (${yearsOk} años, ${listings.length} avisos)`,
      generado: new Date().toISOString().slice(0, 10),
      dLat: D_LAT,
      dLon: D_LON,
      minSamples: MIN_SAMPLES,
      clampMultiplicador: [0.7, 1.4],
      barreras: `FFCC GCBA (${ffcc.length}) + autopistas OSM (${autopistas.length})`,
    },
    cells: Object.fromEntries(
      [...cells.entries()].map(([k, c]) => [k, [Number(c.multiplier.toFixed(3)), c.count, c.smoothed ? 1 : 0]]),
    ),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'micro-index.json'), JSON.stringify(index));
  const barrerasGeo = {
    type: 'FeatureCollection',
    features: barriers.map((line) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: line.map((p) => [p.lon, p.lat]) },
    })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'barreras.geojson'), JSON.stringify(barrerasGeo));
  console.log('Listo ✓');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: CORRER el script de verdad** — `npx tsx scripts/build-geo-index.ts` (timeout 600000ms; descarga ~7 CSVs grandes + capas). Si los nombres de columnas reales de algún año no matchean los alias de `field()`, inspeccioná el header del CSV cacheado (`head -1 scripts/.cache/deptos-<año>.csv`) y AGREGÁ el alias que falte (no debilites los filtros de sanidad). Si la URL de un año devuelve 404, probá el patrón alternativo desde la página del dataset (API CKAN `package_show?id=departamentos-venta` lista los resources con sus URLs reales) — ajustá `GCBA_CSV`/la lógica para resolver URLs vía CKAN si hace falta. Reportá en tu informe: avisos aceptados por año, total, # celdas, percentiles del multiplicador.

Expected: índice con miles de celdas, p50 ≈ 1.00 (sano: la mediana relativa es ~1), p5/p95 dentro de [0.7, 1.4].

- [ ] **Step 4: Test de schema sobre el índice real** — crear `src/server/tasacion/__tests__/micro-index.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import index from '../data/micro-index.json';

describe('micro-index.json (schema del índice commiteado)', () => {
  it('tiene meta completa y suficientes celdas', () => {
    expect(index.meta.fuente.length).toBeGreaterThan(0);
    expect(index.meta.generado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(index.cells).length).toBeGreaterThanOrEqual(1000);
  });
  it('todos los multiplicadores dentro del clamp y counts > 0', () => {
    for (const [key, cell] of Object.entries(index.cells as Record<string, [number, number, number]>)) {
      expect(key).toMatch(/^-?\d+_-?\d+$/);
      expect(cell[0]).toBeGreaterThanOrEqual(0.7);
      expect(cell[0]).toBeLessThanOrEqual(1.4);
      expect(cell[1]).toBeGreaterThan(0);
    }
  });
});
```

Run: `pnpm run test:unit -- micro-index` → PASS contra el archivo generado.

- [ ] **Step 5: Actualizar `src/server/tasacion/data/README.md`** — agregar fila a la tabla: `micro-index.json + barreras.geojson | npx tsx scripts/build-geo-index.ts (regenera de GCBA+OSM; ~5 min) | GCBA Departamentos en Venta + Overpass`.

- [ ] **Step 6: Commit** (FOREGROUND, timeout 420000ms). El JSON del índice puede pesar unos cientos de KB — verificá con `ls -la src/server/tasacion/data/` y reportá tamaños; si `micro-index.json` > 2MB algo anda mal (¿olvidaste toFixed(3)?).

```bash
git add scripts/build-geo-index.ts src/server/tasacion/data/micro-index.json src/server/tasacion/data/barreras.geojson src/server/tasacion/data/README.md src/server/tasacion/__tests__/micro-index.test.ts .gitignore package.json pnpm-lock.yaml
git commit -m "feat: build geo micro-index from GCBA historical data (one-time script + generated index)"
```

---

### Task 3: Runtime geo (geocoder USIG + lookup)

**Files:**
- Create: `src/server/tasacion/geo.ts`
- Test: `src/server/tasacion/__tests__/geo.test.ts`

- [ ] **Step 1: Test que falla**:

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import { geocodeUSIG, microLookup } from '../geo';
import { cellKey } from '../geo-build';
import index from '../data/micro-index.json';

describe('geocodeUSIG', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parsea la respuesta USIG (x=LON, y=LAT, invertido)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        direccionesNormalizadas: [
          { direccion: 'PEDRO GOYENA AV. 600, CABA', coordenadas: { srid: 4326, x: '-58.4283', y: '-34.6244' } },
        ],
      }),
    } as Response);
    const r = await geocodeUSIG('Pedro Goyena 600');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(-34.6244);
    expect(r!.lon).toBeCloseTo(-58.4283);
    expect(r!.direccionNormalizada).toContain('PEDRO GOYENA');
  });

  it('null ante dirección no encontrada, HTTP error o excepción', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ direccionesNormalizadas: [] }) } as Response);
    expect(await geocodeUSIG('xyz')).toBeNull();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    expect(await geocodeUSIG('xyz')).toBeNull();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    expect(await geocodeUSIG('xyz')).toBeNull();
  });
});

describe('microLookup', () => {
  it('devuelve la celda del índice real para una clave existente', () => {
    const [key, cell] = Object.entries(index.cells as Record<string, [number, number, number]>)[0];
    const [i, j] = key.split('_').map(Number);
    // reconstruyo un punto dentro de esa celda
    const lat = (i + 0.5) * index.meta.dLat;
    const lon = (j + 0.5) * index.meta.dLon;
    expect(cellKey(lat, lon)).toBe(key);
    const r = microLookup(lat, lon);
    expect(r).toEqual({ multiplicador: cell[0], avisos: cell[1], smoothed: cell[2] === 1 });
  });
  it('null fuera del índice', () => {
    expect(microLookup(0, 0)).toBeNull();
  });
});
```

- [ ] **Step 2:** FAIL → **implementar `src/server/tasacion/geo.ts`**:

```ts
import { cellKey } from './geo-build';
import index from './data/micro-index.json';

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

const CELLS = index.cells as Record<string, [number, number, number]>;

/** Lookup O(1) del multiplicador de micro-zona. Null si la celda no tiene datos. */
export function microLookup(lat: number, lon: number): MicroCell | null {
  const c = CELLS[cellKey(lat, lon)];
  return c ? { multiplicador: c[0], avisos: c[1], smoothed: c[2] === 1 } : null;
}
```

- [ ] **Step 3:** Run `pnpm run test:unit -- "tasacion/__tests__/geo\.test"` → PASS.

- [ ] **Step 4: Commit** (FOREGROUND): `git add src/server/tasacion/geo.ts src/server/tasacion/__tests__/geo.test.ts && git commit -m "feat: USIG geocoder + O(1) micro-zone lookup"`

---

### Task 4: Tipos v3 + extracción con dirección + mejoras (TDD)

**Files:**
- Modify: `src/types/tasacion.ts`, `src/server/llm/tasacion-extract.ts` (+ su test)
- Create: `src/server/tasacion/mejoras.ts`
- Test: `src/server/tasacion/__tests__/mejoras.test.ts`

- [ ] **Step 1: Tipos** — en `src/types/tasacion.ts`: agregar a `TasacionInput` el campo `direccion: string | null;` (después de `barrio`), y al final del archivo:

```ts
export interface Mejora {
  campo: string;
  sugerencia: string;
  impacto: string;
}

export interface UbicacionInfo {
  lat: number;
  lon: number;
  direccionNormalizada: string;
  multiplicador: number;
  avisos: number; // 0 = celda sin datos (multiplicador 1.0)
  smoothed: boolean;
}
```

Y a `TasacionResult`: `ubicacion: UbicacionInfo | null;` y `mejoras: Mejora[];`.

- [ ] **Step 2: Extracción** — en `src/server/llm/tasacion-extract.ts`: al schema agregar `direccion: { type: ['string', 'null'] },` y `'direccion'` al array `required`. Al prompt, en las guías, agregar la línea:

```
- "direccion": calle y altura si aparecen (ej: "Pedro Goyena 600", "Av. Rivadavia 5000"); null si no hay dirección concreta.
```

En su test, agregar `direccion: 'Pedro Goyena 600',` al mock de structured_output y assert `expect(input.direccion).toBe('Pedro Goyena 600');`.

Run: `pnpm run test:unit -- tasacion-extract` → PASS.

- [ ] **Step 3: Test de mejoras que falla** — `src/server/tasacion/__tests__/mejoras.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { derivarMejoras } from '../mejoras';
import type { TasacionInput, UbicacionInfo } from '~/types';

const completa: TasacionInput = {
  tipoPropiedad: 'departamento',
  barrio: 'Palermo',
  direccion: 'Thames 1500',
  m2Cubiertos: 75,
  m2Semicubiertos: null,
  m2Balcon: 8,
  m2Descubiertos: null,
  piso: 5,
  tieneAscensor: true,
  ubicacionPlanta: 'frente',
  antiguedadAnios: 20,
  estadoConservacion: 2,
  tieneCochera: true,
  tieneBaulera: false,
  amenities: ['pileta'],
  categoriaConstructiva: 'buena',
  aEstrenar: false,
};

const geoOk: UbicacionInfo = {
  lat: -34.58,
  lon: -58.42,
  direccionNormalizada: 'THAMES 1500',
  multiplicador: 1.1,
  avisos: 20,
  smoothed: false,
};

describe('derivarMejoras', () => {
  it('input completo con geo → sin mejoras', () => {
    expect(derivarMejoras(completa, geoOk)).toHaveLength(0);
  });

  it('cada faltante dispara su mejora, en orden de impacto', () => {
    const input: TasacionInput = {
      ...completa,
      direccion: null,
      antiguedadAnios: null,
      estadoConservacion: null,
      piso: null,
      ubicacionPlanta: null,
      categoriaConstructiva: null,
      m2Balcon: null,
      tieneCochera: false,
      amenities: [],
    };
    const m = derivarMejoras(input, null);
    expect(m.map((x) => x.campo)).toEqual([
      'direccion',
      'antiguedadAnios',
      'estadoConservacion',
      'piso',
      'ubicacionPlanta',
      'categoriaConstructiva',
      'm2Balcon',
      'tieneCochera',
      'amenities',
    ]);
  });

  it('dirección presente pero sin geocodificar → mejora de dirección', () => {
    const m = derivarMejoras(completa, null);
    expect(m.some((x) => x.campo === 'direccion')).toBe(true);
  });

  it('geo presente pero celda sin datos NO pide dirección', () => {
    const m = derivarMejoras(completa, { ...geoOk, multiplicador: 1, avisos: 0 });
    expect(m.some((x) => x.campo === 'direccion')).toBe(false);
  });
});
```

- [ ] **Step 4: Implementar `src/server/tasacion/mejoras.ts`**:

```ts
import type { Mejora, TasacionInput, UbicacionInfo } from '~/types';

/**
 * Checklist determinística "para mejorar esta tasación": derivada de los campos ausentes
 * del input y del estado de la geocodificación. Cero LLM. Orden = impacto en el valor.
 */
export function derivarMejoras(input: TasacionInput, geo: UbicacionInfo | null): Mejora[] {
  const m: Mejora[] = [];
  if (!geo) {
    m.push({
      campo: 'direccion',
      sugerencia: input.direccion
        ? `La dirección "${input.direccion}" no se pudo geocodificar — probá con formato "calle altura" (ej: Pedro Goyena 600)`
        : 'Agregá calle y altura (ej: Pedro Goyena 600) para tasar la micro-zona exacta',
      impacto: 'hasta ±25% por micro-zona',
    });
  }
  if (input.antiguedadAnios === null) {
    m.push({ campo: 'antiguedadAnios', sugerencia: 'Indicá los años de antigüedad', impacto: 'hasta ±15%' });
  }
  if (input.estadoConservacion === null) {
    m.push({
      campo: 'estadoConservacion',
      sugerencia: 'Describí el estado (a estrenar / muy bueno / original / a refaccionar)',
      impacto: 'hasta ±15%',
    });
  }
  if (input.piso === null) {
    m.push({ campo: 'piso', sugerencia: 'Decí el piso (y si hay ascensor)', impacto: 'hasta ±20%' });
  }
  if (!input.ubicacionPlanta) {
    m.push({ campo: 'ubicacionPlanta', sugerencia: '¿Frente, contrafrente o interno?', impacto: 'hasta −20%' });
  }
  if (!input.categoriaConstructiva) {
    m.push({
      campo: 'categoriaConstructiva',
      sugerencia: 'Categoría del edificio (estándar / de categoría con servicios / torre premium)',
      impacto: 'hasta +35%',
    });
  }
  if (input.m2Balcon === null) {
    m.push({ campo: 'm2Balcon', sugerencia: 'Si tiene balcón, indicá los m²', impacto: 'suma directa' });
  }
  if (!input.tieneCochera) {
    m.push({ campo: 'tieneCochera', sugerencia: 'Si tiene cochera, decilo explícitamente', impacto: '+USD 25-50 mil' });
  }
  if (input.amenities.length === 0) {
    m.push({ campo: 'amenities', sugerencia: 'Mencioná amenities si los hay (pileta, gym, sum…)', impacto: 'hasta +10%' });
  }
  return m;
}
```

- [ ] **Step 5:** Run `pnpm run test:unit -- mejoras` → PASS. **Nota:** los tests existentes del engine van a fallar por el campo `direccion` faltante en sus fixtures — es esperado, Task 5 los arregla. Verificá que extract + mejoras + geo + geo-build + micro-index pasen.

- [ ] **Step 6: Commit** (FOREGROUND): `git add src/types/tasacion.ts src/server/llm src/server/tasacion/mejoras.ts src/server/tasacion/__tests__/mejoras.test.ts && git commit -m "feat: direccion extraction, Mejora/UbicacionInfo types, improvement checklist"`

---

### Task 5: Motor v3 (micro-zona + confianza v2)

**Files:**
- Modify: `src/server/tasacion/engine.ts`, `src/server/tasacion/__tests__/engine.test.ts`

- [ ] **Step 1: Actualizar el test** — en `engine.test.ts`:

(a) Agregar `direccion: null,` al fixture `base` (después de `barrio`).

(b) Agregar al final del describe 'tasar — cálculo':

```ts
  it('aplica el multiplicador de micro-zona al precio base y lo muestra en el breakdown', () => {
    const geo = {
      lat: -34.62,
      lon: -58.43,
      direccionNormalizada: 'PEDRO GOYENA AV. 600',
      multiplicador: 1.15,
      avisos: 43,
      smoothed: false,
    };
    const conGeo = tasar({ ...base, direccion: 'Pedro Goyena 600' }, geo);
    const sinGeo = tasar(base);
    expect(conGeo.valorEstimadoUsd).toBeGreaterThan(sinGeo.valorEstimadoUsd * 1.1);
    expect(conGeo.breakdown.some((b) => b.concepto.includes('Micro-zona'))).toBe(true);
    expect(conGeo.ubicacion).toEqual(geo);
    expect(conGeo.mejoras.some((x) => x.campo === 'direccion')).toBe(false);
  });

  it('celda sin datos → multiplicador 1.0, supuesto y −5 de confianza', () => {
    const geo = { lat: -34.62, lon: -58.43, direccionNormalizada: 'X 1', multiplicador: 1, avisos: 0, smoothed: false };
    const r = tasar({ ...base, direccion: 'X 1' }, geo);
    expect(r.supuestos.some((s) => s.includes('sin datos'))).toBe(true);
    expect(r.confianza).toBe('alta'); // 100 − 5 = 95
  });

  it('confianza v2: sin dirección −10; dirección que no geocodifica −10', () => {
    // base no tiene dirección → 100 − 10 = 90 (alta)
    expect(tasar(base).confianza).toBe('alta');
    // con dirección pero geo null (no geocodificó) → 100 − 10 = 90 (alta) + supuesto
    const r = tasar({ ...base, direccion: 'Calle Falsa 123' }, null);
    expect(r.confianza).toBe('alta');
    expect(r.supuestos.some((s) => s.includes('geocodificar'))).toBe(true);
    expect(r.ubicacion).toBeNull();
  });
```

(c) En el test 'datos faltantes…' el esperado de confianza sigue siendo `'media'` (100 −10 −10 −5 −5 −10[sin dirección] = 60 → media). Verificá que el assert diga 'media' (ya lo dice) — el comentario podés actualizarlo.

- [ ] **Step 2:** Run `pnpm run test:unit -- tasacion/__tests__/engine` → FAIL (firma vieja).

- [ ] **Step 3: Modificar `engine.ts`**:

(a) Imports nuevos: `import { derivarMejoras } from './mejoras';` y los tipos `UbicacionInfo`, `Mejora` desde `~/types`.

(b) Firma: `export function tasar(input: TasacionInput, geo: UbicacionInfo | null = null): TasacionResult {`

(c) Justo DESPUÉS del bloque del precio base del barrio (sección 2), insertar la sección micro-zona:

```ts
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
      supuestos.push('la cuadra no tiene datos históricos suficientes — se usó la media del barrio');
      breakdown.push({
        concepto: `Micro-zona (${geo.direccionNormalizada})`,
        valor: '×1.00',
        efecto: 'sin datos históricos suficientes en la celda',
      });
    }
  } else if (input.direccion) {
    supuestos.push(`la dirección "${input.direccion}" no se pudo geocodificar — tasación a nivel barrio`);
  }
```

(d) En el cálculo de `precioAjustado`, reemplazar `barrio.usdM2` por `usdM2Base`.

(e) Confianza — agregar tres penalizaciones:

```ts
  if (!input.direccion) score -= 10;
  if (input.direccion && !geo) score -= 10;
  if (geo && geo.avisos === 0) score -= 5;
```

(f) Return — agregar: `ubicacion: geo,` y `mejoras: derivarMejoras(input, geo),`.

- [ ] **Step 4:** Run `pnpm run test:unit -- tasacion/__tests__/engine` → PASS (13 tests). Después `pnpm run test:unit` completo → verde (el route todavía compila porque `geo` es opcional — verificalo).

- [ ] **Step 5: Commit** (FOREGROUND): `git add src/server/tasacion/engine.ts src/server/tasacion/__tests__/engine.test.ts && git commit -m "feat: engine v3 with micro-zone multiplier and confidence v2"`

---

### Task 6: Route de tasación orquestando geo

**Files:**
- Modify: `src/app/api/tasacion/route.ts`

- [ ] **Step 1:** Reescribir el `try` del POST para orquestar geocode + lookup:

```ts
  try {
    const { input } = await runTasacionExtract(description);
    if (!input.barrio && !input.m2Cubiertos) {
      return NextResponse.json(
        { error: 'No pude detectar ni el barrio ni los m² en la descripción — son los datos mínimos para tasar.' },
        { status: 400 },
      );
    }
    let geo: UbicacionInfo | null = null;
    if (input.direccion) {
      const point = await geocodeUSIG(input.direccion);
      if (point) {
        const cell = microLookup(point.lat, point.lon);
        geo = {
          ...point,
          multiplicador: cell?.multiplicador ?? 1,
          avisos: cell?.avisos ?? 0,
          smoothed: cell?.smoothed ?? false,
        };
      }
    }
    const result = tasar(input, geo);
    return NextResponse.json({ input, result });
  } catch (err) {
```

Imports nuevos: `import { geocodeUSIG, microLookup } from '~/server/tasacion/geo';` y `import type { UbicacionInfo } from '~/types';`.

- [ ] **Step 2:** Run `pnpm run lint && pnpm run build` (timeout 600000ms) → PASS.

- [ ] **Step 3: Commit** (FOREGROUND): `git add src/app/api/tasacion && git commit -m "feat: tasacion route orchestrates geocoding + micro-zone lookup"`

---

### Task 7: DB + API de tasaciones guardadas (TDD)

**Files:**
- Modify: `src/server/db.ts`, `src/server/__tests__/db.test.ts`
- Create: `src/app/api/tasaciones/route.ts`, `src/app/api/tasaciones/[id]/route.ts`

- [ ] **Step 1: Test de db que falla** — agregar a `db.test.ts` (leé el archivo primero para reusar sus fixtures/estructura):

```ts
describe('tasaciones guardadas', () => {
  const input = { tipoPropiedad: 'departamento', barrio: 'Palermo', direccion: 'Thames 1500' };
  const result = { valorEstimadoUsd: 250_000, confianza: 'alta', ubicacion: { direccionNormalizada: 'THAMES 1500' } };

  it('guarda y recupera una tasación completa', () => {
    db.saveTasacion('t1', 'depto en palermo...', input, result);
    const t = db.getTasacion('t1');
    expect(t?.description).toBe('depto en palermo...');
    expect(t?.input).toMatchObject({ barrio: 'Palermo' });
    expect(t?.result).toMatchObject({ valorEstimadoUsd: 250_000 });
  });

  it('lista resumida ordenada por fecha desc', () => {
    db.saveTasacion('t1', 'd1', input, result);
    db.saveTasacion('t2', 'd2', { ...input, barrio: 'Flores' }, { ...result, valorEstimadoUsd: 100_000 });
    const list = db.getTasaciones();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: expect.any(String), valorEstimadoUsd: expect.any(Number), confianza: 'alta' });
    expect(list[0].titulo.length).toBeGreaterThan(0);
  });

  it('getTasacion inexistente → undefined', () => {
    expect(db.getTasacion('nope')).toBeUndefined();
  });
});
```

(Los objetos `input`/`result` de los tests son parciales a propósito — los métodos guardan/parsean JSON opaco; tipalos como `unknown`/`Record<string, unknown>` en el método, no como TasacionInput estricto.)

- [ ] **Step 2:** FAIL → **modificar `db.ts`**: agregar al SCHEMA:

```sql
CREATE TABLE IF NOT EXISTS tasaciones (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT NOT NULL
);
```

Prepared statements + métodos (siguiendo el patrón existente):

```ts
export interface TasacionGuardada {
  id: string;
  fecha: string;
  description: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface TasacionListItem {
  id: string;
  fecha: string;
  titulo: string;
  valorEstimadoUsd: number;
  confianza: string;
}
```

```ts
    saveTasacion(id: string, description: string, input: unknown, result: unknown) {
      stmtSaveTasacion.run(id, description, JSON.stringify(input), JSON.stringify(result));
    },
    getTasacion(id: string): TasacionGuardada | undefined {
      const row = stmtGetTasacion.get(id) as
        | { id: string; fecha: string; description: string; input: string; result: string }
        | undefined;
      if (!row) return undefined;
      return { ...row, input: JSON.parse(row.input), result: JSON.parse(row.result) };
    },
    getTasaciones(): TasacionListItem[] {
      const rows = stmtListTasaciones.all() as { id: string; fecha: string; input: string; result: string }[];
      return rows.map((r) => {
        const input = JSON.parse(r.input) as { direccion?: string | null; barrio?: string | null };
        const result = JSON.parse(r.result) as {
          valorEstimadoUsd?: number;
          confianza?: string;
          ubicacion?: { direccionNormalizada?: string } | null;
        };
        return {
          id: r.id,
          fecha: r.fecha,
          titulo: result.ubicacion?.direccionNormalizada ?? input.direccion ?? input.barrio ?? 's/d',
          valorEstimadoUsd: result.valorEstimadoUsd ?? 0,
          confianza: result.confianza ?? 's/d',
        };
      });
    },
```

con `stmtSaveTasacion = db.prepare('INSERT OR REPLACE INTO tasaciones (id, description, input, result) VALUES (?, ?, ?, ?)')`, `stmtGetTasacion = db.prepare('SELECT * FROM tasaciones WHERE id = ?')`, `stmtListTasaciones = db.prepare('SELECT id, fecha, input, result FROM tasaciones ORDER BY fecha DESC, id DESC')`.

Run `pnpm run test:unit -- __tests__/db` → PASS.

- [ ] **Step 3: Rutas** — `src/app/api/tasaciones/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDb } from '~/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { description?: string; input?: unknown; result?: unknown };
  if (!body.description || !body.input || !body.result) {
    return NextResponse.json({ error: 'payload incompleto' }, { status: 400 });
  }
  const id = randomUUID();
  getDb().saveTasacion(id, body.description, body.input, body.result);
  return NextResponse.json({ id });
}

export async function GET() {
  return NextResponse.json({ tasaciones: getDb().getTasaciones() });
}
```

`src/app/api/tasaciones/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getDb } from '~/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = getDb().getTasacion(id);
  if (!t) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(t);
}
```

- [ ] **Step 4:** `pnpm run lint && pnpm run build` → PASS. **Commit** (FOREGROUND): `git add src/server/db.ts src/server/__tests__/db.test.ts src/app/api/tasaciones && git commit -m "feat: saved tasaciones (sqlite history + api)"`

---

### Task 8: UI — mapa, panel de mejoras, guardar/historial/export

**Files:**
- Create: `src/containers/Tasacion/MapaUbicacion.tsx`, `src/containers/Tasacion/HistorialTasaciones.tsx`
- Modify: `src/containers/Tasacion/TasacionPage.tsx`, `package.json` (deps)

- [ ] **Step 1: Deps** — `pnpm add leaflet html-to-image && pnpm add -D @types/leaflet`.

- [ ] **Step 2: Crear `src/containers/Tasacion/MapaUbicacion.tsx`** (Leaflet plano, client-only, sin assets de íconos — circleMarker):

```tsx
'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { UbicacionInfo } from '~/types';

type Props = { ubicacion: UbicacionInfo };

export const MapaUbicacion = ({ ubicacion }: Props) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: import('leaflet').Map | null = null;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !ref.current) return;
      map = L.map(ref.current, { zoomControl: false, attributionControl: true }).setView(
        [ubicacion.lat, ubicacion.lon],
        16,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        crossOrigin: 'anonymous', // necesario para exportar el canvas sin taint
        maxZoom: 19,
      }).addTo(map);
      L.circleMarker([ubicacion.lat, ubicacion.lon], {
        radius: 9,
        color: '#d32f2f',
        fillColor: '#d32f2f',
        fillOpacity: 0.85,
      }).addTo(map);
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [ubicacion.lat, ubicacion.lon]);

  return <div ref={ref} style={{ width: '100%', height: '220px', borderRadius: 8 }} data-testid='mapa-ubicacion' />;
};
```

- [ ] **Step 3: Crear `src/containers/Tasacion/HistorialTasaciones.tsx`**:

```tsx
'use client';

import { useEffect, useState } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Chip, List, ListItemButton, ListItemText, Typography } from '@mui/material';

interface Item {
  id: string;
  fecha: string;
  titulo: string;
  valorEstimadoUsd: number;
  confianza: string;
}

type Props = {
  refreshKey: number; // se incrementa al guardar para refrescar la lista
  onOpen: (id: string) => void;
};

export const HistorialTasaciones = ({ refreshKey, onOpen }: Props) => {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    void fetch('/api/tasaciones')
      .then((r) => r.json())
      .then((d: { tasaciones?: Item[] }) => setItems(d.tasaciones ?? []))
      .catch(() => setItems([]));
  }, [refreshKey]);

  if (items.length === 0) return null;
  return (
    <Accordion disableGutters variant='outlined' sx={{ width: '100%' }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant='caption'>Historial ({items.length})</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        <List dense>
          {items.map((t) => (
            <ListItemButton key={t.id} onClick={() => onOpen(t.id)}>
              <ListItemText
                primary={`${t.titulo} — USD ${t.valorEstimadoUsd.toLocaleString('es-AR')}`}
                secondary={t.fecha}
              />
              <Chip size='small' label={t.confianza} />
            </ListItemButton>
          ))}
        </List>
      </AccordionDetails>
    </Accordion>
  );
};
```

- [ ] **Step 4: Modificar `TasacionPage.tsx`** — leé el archivo actual y aplicá estos agregados (manteniendo todo lo existente):

1. Imports: `useRef`, `toPng` de `html-to-image`, `MapaUbicacion`, `HistorialTasaciones`.
2. Placeholder del textarea → la plantilla ideal:

```ts
const PLACEHOLDER = `Describí el inmueble. Ideal: "Departamento de 3 ambientes en Caballito, Pedro Goyena 600, piso 4 al frente con ascensor, 75 m² cubiertos + balcón de 6 m², 20 años, muy buen estado, edificio de categoría con pileta y sum, con cochera."`;
```

3. Estado nuevo: `const cardRef = useRef<HTMLDivElement>(null);` · `const [guardada, setGuardada] = useState(false);` · `const [refreshKey, setRefreshKey] = useState(0);` — y en `tasarInmueble` resetear `setGuardada(false)`.
4. Funciones:

```ts
  const guardar = async () => {
    if (!data) return;
    const res = await fetch('/api/tasaciones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: description.trim(), input: data.input, result: data.result }),
    });
    if (res.ok) {
      setGuardada(true);
      setRefreshKey((k) => k + 1);
    }
  };

  const abrirGuardada = async (id: string) => {
    const res = await fetch(`/api/tasaciones/${id}`);
    if (!res.ok) return;
    const t = (await res.json()) as { description: string; input: TasacionInput; result: TasacionResult };
    setDescription(t.description);
    setData({ input: t.input, result: t.result });
    setGuardada(true);
    setError(null);
  };

  const exportarPng = async () => {
    if (!cardRef.current) return;
    try {
      const url = await toPng(cardRef.current, { cacheBust: true, backgroundColor: '#ffffff' });
      const a = document.createElement('a');
      a.href = url;
      a.download = `tasacion-${new Date().toISOString().slice(0, 10)}-${data?.input.barrio ?? 'caba'}.png`;
      a.click();
    } catch {
      setError('No se pudo exportar la imagen (mapa con CORS) — usá imprimir como alternativa.');
    }
  };
```

5. Render — dentro del `<Paper data-testid='tasacion-result'>` (que ahora lleva `ref={cardRef}`):
   - Después de los chips interpretados: `{r.ubicacion && <MapaUbicacion ubicacion={r.ubicacion} />}` y si `r.ubicacion?.avisos ? (` una línea `Typography variant='caption'` con `Micro-zona: ×{r.ubicacion.multiplicador.toFixed(2)} vs media del barrio ({r.ubicacion.avisos} avisos históricos)`.
   - Después del accordion del breakdown, el panel de mejoras:

```tsx
            {r.mejoras.length > 0 && (
              <Stack spacing={0.5} data-testid='mejoras'>
                <Typography variant='subtitle2'>Para mejorar esta tasación:</Typography>
                {r.mejoras.map((mj) => (
                  <Typography key={mj.campo} variant='caption'>
                    • {mj.sugerencia} <b>({mj.impacto})</b>
                  </Typography>
                ))}
              </Stack>
            )}
```

   - Botonera al final de la tarjeta:

```tsx
            <Stack direction='row' spacing={1}>
              <Button size='small' variant='outlined' onClick={guardar} disabled={guardada} data-testid='guardar-button'>
                {guardada ? 'Guardada ✓' : 'Guardar'}
              </Button>
              <Button size='small' variant='outlined' onClick={exportarPng} data-testid='export-button'>
                Exportar PNG
              </Button>
            </Stack>
```

   - Fuera de la tarjeta, al final de la página: `<HistorialTasaciones refreshKey={refreshKey} onOpen={abrirGuardada} />`.

- [ ] **Step 5:** `pnpm run lint && pnpm run build` (timeout 600000ms) → PASS (si Next se queja del CSS de leaflet importado en un componente cliente, movelo a `src/app/layout.tsx` como `import 'leaflet/dist/leaflet.css';`). `pnpm run test:unit` → sin regresiones.

- [ ] **Step 6: Commit** (FOREGROUND): `git add src/containers/Tasacion package.json pnpm-lock.yaml src/app 2>/dev/null; git commit -m "feat: map, improvement checklist, save/history/export in tasacion UI"`

---

### Task 9: Smoke real + verificación final

- [ ] **Step 1: Smoke (consume ~10k tokens, 1 extracción)** — `pnpm run dev` en background, esperar Ready:

```bash
curl -s -X POST http://localhost:3000/api/tasacion -H 'Content-Type: application/json' \
  -d '{"description":"Departamento de 4 ambientes en Caballito, Pedro Goyena 600, primer piso al contrafrente, 114 m2 cubiertos y patio de 7 m2, 24 anos, excelentes condiciones, edificio muy bueno con pileta y sum con parrilla."}'
```

Expected: 200; `result.ubicacion` con lat/lon de Pedro Goyena (≈ -34.62, -58.43), `direccionNormalizada` conteniendo "GOYENA"; breakdown con línea "Micro-zona" (×algo ≠ 1.00 idealmente — Caballito/Goyena tiene datos históricos densos); `mejoras` listando cochera/balcón. Después: guardar vía `POST /api/tasaciones` con el payload devuelto → `{id}`; `GET /api/tasaciones` lista 1 item con titulo GOYENA. Matar dev server.

- [ ] **Step 2:** `pnpm run lint && pnpm run prettier && pnpm run test:unit && pnpm run build` → todo verde (prettier:fix + recommit si marca). `git status` limpio.

- [ ] **Step 3: Commit final si quedó algo**: `git add -A && git commit -m "chore: geo-microzona final cleanup" || echo clean`

---

## Notas para el ejecutor

- **No setear `ANTHROPIC_API_KEY`** (suscripción Claude Code). El script de build NO usa LLM — es solo descarga + cómputo.
- WSL /mnt/c: lento. Timeouts generosos; commits SIEMPRE en foreground con timeout 420000ms (no backgroundear: quedan huérfanos).
- Task 2 toca red real (GCBA/Overpass): si una fuente cambió, resolvé URLs vía la API CKAN del portal (`package_show`) en vez de hardcodear; reportá stats del índice generado (años, avisos, celdas, percentiles) — el reviewer las necesita para validar.
- GPG deshabilitado. No tocar nada fuera del alcance de cada task.
