/** @jest-environment node */
import { expect } from '@jest/globals';
import { matchBarrio, valorCochera } from '../barrios';
import precios from '../data/precios-barrio.json';

describe('precios-barrio.json (schema)', () => {
  it('todo barrio tiene usdM2 > 0, fuente y fecha', () => {
    for (const [nombre, v] of Object.entries(precios.barrios)) {
      expect(nombre).toBe(nombre.toLowerCase());
      expect(v.usdM2).toBeGreaterThan(0);
      expect(v.fuente.length).toBeGreaterThan(0);
      expect(v.fecha).toMatch(/^\d{4}-\d{2}$/);
    }
    expect(precios.fallback.usdM2).toBeGreaterThan(0);
  });
});

describe('matchBarrio', () => {
  it('matchea exacto, con mayúsculas y acentos', () => {
    expect(matchBarrio('Palermo').usdM2).toBe(3403);
    expect(matchBarrio('NÚÑEZ').usdM2).toBe(3392);
    expect(matchBarrio('Constitución').fallback).toBe(false);
  });
  it('resuelve alias y sub-barrios', () => {
    expect(matchBarrio('Lugano').usdM2).toBe(1058);
    expect(matchBarrio('Barrio Norte').usdM2).toBe(2459); // → recoleta
    expect(matchBarrio('Palermo Soho').usdM2).toBe(3403);
    expect(matchBarrio('Las Cañitas').usdM2).toBe(3403);
  });
  it('barrio desconocido o null → fallback CABA promedio con flag', () => {
    const m = matchBarrio('Marte');
    expect(m.fallback).toBe(true);
    expect(m.usdM2).toBe(2460);
    expect(matchBarrio(null).fallback).toBe(true);
  });
});

describe('valorCochera', () => {
  it('devuelve el valor del barrio o el default', () => {
    expect(valorCochera('Palermo')).toBe(42500);
    expect(valorCochera('Marte')).toBe(25000);
    expect(valorCochera(null)).toBe(25000);
  });
});
