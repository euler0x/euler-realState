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
