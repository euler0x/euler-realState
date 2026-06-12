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
