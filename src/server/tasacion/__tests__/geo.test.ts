/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import index from '../data/micro-index.json';
import { geocodeUSIG, microLookup } from '../geo';
import { cellKey } from '../geo-build';

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
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({ direccionesNormalizadas: [] }) } as Response);
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
