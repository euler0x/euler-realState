/** @jest-environment node */
import { expect } from '@jest/globals';
import { coefAmenities, coefPiso, interpolate, rossHeideckeK, ESCALA_TABLE } from '../constants';

describe('coefPiso', () => {
  it('con ascensor: PB 0.90, 1° 0.95, 3° base 1.0, sube 0.02/piso con tope 1.15', () => {
    expect(coefPiso(0, true)).toBeCloseTo(0.9);
    expect(coefPiso(1, true)).toBeCloseTo(0.95);
    expect(coefPiso(3, true)).toBeCloseTo(1.0);
    expect(coefPiso(5, true)).toBeCloseTo(1.04);
    expect(coefPiso(20, true)).toBeCloseTo(1.15); // tope
  });
  it('sin ascensor: PB 1.0 y baja 0.05 por piso (piso 0.70 mínimo)', () => {
    expect(coefPiso(0, false)).toBeCloseTo(1.0);
    expect(coefPiso(2, false)).toBeCloseTo(0.9);
    expect(coefPiso(10, false)).toBeCloseTo(0.7); // piso del coeficiente
  });
  it('piso null → neutro 1.0; ascensor null → se asume con ascensor', () => {
    expect(coefPiso(null, true)).toBeCloseTo(1.0);
    expect(coefPiso(5, null)).toBeCloseTo(1.04);
  });
});

describe('interpolate', () => {
  it('interpola linealmente y clampea en los extremos', () => {
    expect(interpolate(ESCALA_TABLE, 85)).toBeCloseTo(1.0);
    expect(interpolate(ESCALA_TABLE, 25)).toBeCloseTo(1.35);
    expect(interpolate(ESCALA_TABLE, 20)).toBeCloseTo(1.35); // clamp inferior
    expect(interpolate(ESCALA_TABLE, 500)).toBeCloseTo(0.9); // clamp superior
    const mid = interpolate(ESCALA_TABLE, 67.5); // entre 60 (1.08) y 75 (1.02)
    expect(mid).toBeGreaterThan(1.02);
    expect(mid).toBeLessThan(1.08);
  });
});

describe('rossHeideckeK', () => {
  it('estado excelente nuevo no deprecia; 100% de vida deprecia total', () => {
    expect(rossHeideckeK(0, 1.0)).toBeCloseTo(0);
    expect(rossHeideckeK(100, 2.5)).toBeCloseTo(1.0);
  });
  it('valores de tabla exactos (50% vida, estado bueno 2.0 → 0.293)', () => {
    expect(rossHeideckeK(50, 2.0)).toBeCloseTo(0.293);
  });
  it('interpola entre filas y entre estados; clampea estado a [1.0, 3.5]', () => {
    const k = rossHeideckeK(25, 2.25); // entre filas 20/30 y estados 2.0/2.5
    expect(k).toBeGreaterThan(rossHeideckeK(25, 2.0));
    expect(k).toBeLessThan(rossHeideckeK(25, 2.5));
    expect(rossHeideckeK(50, 4.5)).toBeCloseTo(rossHeideckeK(50, 3.5)); // clamp
  });
});

describe('coefAmenities', () => {
  it('0 → 1.0, 1-2 → 1.05, 3+ → 1.10', () => {
    expect(coefAmenities(0)).toBe(1.0);
    expect(coefAmenities(2)).toBe(1.05);
    expect(coefAmenities(4)).toBe(1.1);
  });
});
