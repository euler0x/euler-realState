/* eslint-disable no-console */
// Construye el micro-índice geográfico de CABA. Se corre UNA VEZ (o al refrescar datos):
//   npx tsx scripts/build-geo-index.ts
// Descarga avisos históricos del GCBA (2012-2016) + barreras (FFCC GCBA, autopistas OSM),
// computa el índice relativo con suavizado por barreras y escribe:
//   src/server/tasacion/data/micro-index.json
//   src/server/tasacion/data/barreras.geojson
//
// NOTAS DE ADAPTACIÓN (URLs reales del CKAN verificadas 2026-06-12):
//   - 2014-2019 hardcodeados originalmente en /secretaria-de-desarrollo-urbano/: solo 2020 existe ahí.
//   - 2012-2016 están en /datasets/departamentos-en-venta/ (path raíz del CDN).
//   - 2017-2019: solo SHP/ZIP, sin CSV con lat/lon → se usan 2012-2016 (5 años OK).
//   - 2020: CSV sin lat/lon (solo dirección) → excluido.
//   - Delimitador real: punto y coma (;) no coma.
//   - Aliases de columnas ajustados a los headers reales de cada año.
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildCells,
  computeRels,
  smoothCells,
  D_LAT,
  D_LON,
  type Polyline,
  type RawListing,
} from '../src/server/tasacion/geo-build';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE = path.join(__dirname, '.cache');
const OUT_DIR = path.join(__dirname, '..', 'src', 'server', 'tasacion', 'data');

// URLs verificadas via CKAN package_show?id=departamentos-venta (2026-06-12)
// 2012-2016 son los únicos años con CSV + lat/lon en el dataset.
const YEAR_URLS: Record<number, string> = {
  2012: 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/departamentos-en-venta/departamentos-en-venta-2012.csv',
  2013: 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/departamentos-en-venta/departamentos-en-venta-2013.csv',
  2014: 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/departamentos-en-venta/departamentos-en-venta-2014.csv',
  2015: 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/departamentos-en-venta/departamentos-en-venta-2015.csv',
  2016: 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/departamentos-en-venta/departamentos-en-venta-2016.csv',
};
const YEARS = Object.keys(YEAR_URLS).map(Number);

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

/** Lee un campo tolerando variantes de nombre entre años (case-insensitive). */
function field(row: Record<string, string>, aliases: string[]): string | undefined {
  for (const key of Object.keys(row)) {
    if (aliases.includes(key.toLowerCase().trim())) return row[key];
  }
  return undefined;
}

// Imprime los headers del primer año para debugging
function logHeaders(csv: string, anio: number): void {
  const firstLine = csv.split('\n')[0];
  console.log(`  ${anio} headers: ${firstLine.slice(0, 200)}`);
}

function parseListings(csv: string, anio: number): RawListing[] {
  // Detectar delimitador: si la primera línea tiene más ";" que "," → punto y coma
  const firstLine = csv.split('\n')[0];
  const delimiter = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';

  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    delimiter,
    trim: true,
  }) as Record<string, string>[];

  const out: RawListing[] = [];
  let rejected = 0;
  for (const row of rows) {
    // lat/lon: 2015-2016 usan LATITUD/LONGITUD; 2012-2014 usan LAT/LON
    const lat = Number(field(row, ['latitud', 'lat', 'y']));
    const lon = Number(field(row, ['longitud', 'long', 'lon', 'lng', 'x']));
    // precio usd/m2: todos los años usan U_S_M2 (salvo 2020 que no tiene lat/lon)
    const usdM2 = Number(field(row, ['u_s_m2', 'preciousdm', 'precio_usd_m2', 'usdm2', 'preciousdxm2']));
    // m2: 2016 usa M2CUB, resto usa M2
    const m2 = Number(field(row, ['m2', 'm2cub', 'm2_cub', 'sup_cubierta', 'm2total']));
    // barrio: 2015 usa BARRIOS (plural), resto BARRIO
    const barrio = (field(row, ['barrio', 'barrios', 'barrios_1']) ?? '').toLowerCase().trim();
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
  // Resource "Red de Ferrocarril (GeoJSON)" del dataset estaciones-ferrocarril.
  // La URL del archivo se resuelve desde la API CKAN del portal:
  const api = 'https://data.buenosaires.gob.ar/api/3/action/package_show?id=estaciones-ferrocarril';
  const meta = await download(api, 'ffcc-meta.json');
  if (!meta) throw new Error('No pude leer los metadatos del dataset de FFCC — abortando (barrera requerida)');
  const pkg = JSON.parse(meta) as { result?: { resources?: { format?: string; name?: string; url?: string }[] } };
  const resources = pkg.result?.resources ?? [];
  console.log(
    `  FFCC dataset resources: ${resources.map((r) => `${r.name}(${r.format})`).join(', ')}`,
  );
  // Buscar GeoJSON de RED (polilíneas), no de estaciones (puntos)
  let res = resources.find(
    (r) => r.format?.toUpperCase() === 'GEOJSON' && (r.name ?? '').toLowerCase().includes('red'),
  );
  // Si no tiene "red" en el nombre, tomar cualquier GeoJSON (puede ser la red)
  if (!res) {
    res = resources.find((r) => r.format?.toUpperCase() === 'GEOJSON');
  }
  if (!res?.url) throw new Error('No encontré el GeoJSON de la red de FFCC en el dataset — abortando');
  console.log(`  FFCC usando resource: ${res.name} → ${res.url}`);
  const gj = await download(res.url, 'ffcc.geojson');
  if (!gj) throw new Error('Descarga del GeoJSON de FFCC falló — abortando');
  const parsed = JSON.parse(gj) as { features?: { geometry?: { type?: string; coordinates?: unknown } }[] };
  const lines = geojsonToPolylines(parsed);
  // Verificar que son polilíneas (red), no puntos (estaciones)
  const lineCount = lines.length;
  if (lineCount === 0) {
    // Si no hay polilíneas, puede ser un dataset de puntos (estaciones) — buscar en otros datasets
    throw new Error(
      `El GeoJSON de FFCC tiene 0 polilíneas (quizás es un dataset de puntos/estaciones, no la red) — abortando`,
    );
  }
  return lines;
}

async function fetchFFCCFallback(): Promise<Polyline[]> {
  // Intento alternativo: buscar en otros datasets del portal GCBA
  const searchApi =
    'https://data.buenosaires.gob.ar/api/3/action/package_search?q=ferrocarril+red&rows=10';
  const results = await download(searchApi, 'ffcc-search.json');
  if (!results) throw new Error('Búsqueda de datasets de FFCC falló — abortando');
  const data = JSON.parse(results) as {
    result?: { results?: { name?: string; resources?: { format?: string; name?: string; url?: string }[] }[] };
  };
  for (const pkg of data.result?.results ?? []) {
    const res = (pkg.resources ?? []).find(
      (r) => r.format?.toUpperCase() === 'GEOJSON' && (r.name ?? '').toLowerCase().includes('red'),
    );
    if (res?.url) {
      console.log(`  FFCC fallback usando: ${pkg.name} → ${res.url}`);
      const gj = await download(res.url, 'ffcc-fallback.geojson');
      if (gj) {
        const parsed = JSON.parse(gj) as { features?: { geometry?: { type?: string; coordinates?: unknown } }[] };
        const lines = geojsonToPolylines(parsed);
        if (lines.length > 0) return lines;
      }
    }
  }
  throw new Error('No encontré dataset de red FFCC con polilíneas — abortando (barrera requerida)');
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
    const url = YEAR_URLS[y];
    const csv = await download(url, `deptos-${y}.csv`);
    if (!csv) continue;
    logHeaders(csv, y);
    listings.push(...parseListings(csv, y));
    yearsOk++;
  }
  if (yearsOk < MIN_YEARS) throw new Error(`Solo ${yearsOk} años descargados (< ${MIN_YEARS}) — abortando`);
  console.log(`  total: ${listings.length} avisos de ${yearsOk} años`);

  console.log('2/4 Descargando barreras…');
  let ffcc: Polyline[];
  try {
    ffcc = await fetchFFCC();
  } catch (e) {
    console.warn(`  ⚠ FFCC primario falló: ${e instanceof Error ? e.message : e}`);
    console.log('  Intentando búsqueda alternativa de FFCC…');
    ffcc = await fetchFFCCFallback();
  }
  console.log(`  FFCC: ${ffcc.length} polilíneas`);
  const autopistas = await fetchAutopistas();
  const barriers = [...ffcc, ...autopistas];

  console.log('3/4 Computando índice…');
  const rels = computeRels(listings);
  const rawCells = buildCells(rels);
  const cells = smoothCells(rawCells, barriers, { minSamples: MIN_SAMPLES, maxDepth: MAX_DEPTH });
  if (cells.size < MIN_CELLS) throw new Error(`Índice con ${cells.size} celdas (< ${MIN_CELLS}) — abortando`);

  const smoothedCount = [...cells.values()].filter((c) => c.smoothed).length;
  const mults = [...cells.values()].map((c) => c.multiplier).sort((a, b) => a - b);
  const pct = (p: number) => mults[Math.floor(p * (mults.length - 1))];
  console.log(
    `  celdas: ${cells.size} (${smoothedCount} smoothed, ${((smoothedCount / cells.size) * 100).toFixed(1)}%) · multiplicador p5=${pct(0.05).toFixed(2)} p50=${pct(0.5).toFixed(2)} p95=${pct(0.95).toFixed(2)}`,
  );

  // Sanity: p50 debería estar muy cerca de 1.0 (el rel es relativo a la mediana del barrio)
  const p50 = pct(0.5);
  if (Math.abs(p50 - 1.0) > 0.05) {
    console.warn(`  ⚠ p50=${p50.toFixed(3)} está lejos de 1.0 (±0.05) — revisar pipeline`);
  }

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
