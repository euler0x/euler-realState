/** @jest-environment node */
import { expect } from '@jest/globals';
import index from '../data/micro-index.json';
import { D_LAT, D_LON } from '../geo-build';

describe('micro-index.json (schema del índice commiteado)', () => {
  it('tiene meta completa y suficientes celdas', () => {
    expect(index.meta.fuente.length).toBeGreaterThan(0);
    expect(index.meta.generado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(index.cells).length).toBeGreaterThanOrEqual(1000);
  });
  it('la grilla del índice coincide con las constantes del runtime', () => {
    // Si cambia D_LAT/D_LON en geo-build.ts hay que regenerar el índice:
    // con grillas distintas, cellKey() apunta a celdas que no existen y todo cae a ×1.0 en silencio.
    expect(index.meta.dLat).toBe(D_LAT);
    expect(index.meta.dLon).toBe(D_LON);
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
