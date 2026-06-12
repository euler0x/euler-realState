/** @jest-environment node */
import { expect } from '@jest/globals';
import type { TasacionInput } from '~/types';
import { tasar, TasacionInputError } from '../engine';

const base: TasacionInput = {
  tipoPropiedad: 'departamento',
  barrio: 'Palermo',
  m2Cubiertos: 75,
  m2Semicubiertos: null,
  m2Balcon: 8,
  m2Descubiertos: null,
  piso: 5,
  tieneAscensor: true,
  ubicacionPlanta: 'frente',
  antiguedadAnios: 20,
  estadoConservacion: 2.0,
  tieneCochera: false,
  tieneBaulera: false,
  amenities: [],
  categoriaConstructiva: 'estandar',
  aEstrenar: false,
};

describe('tasar — validación de entrada', () => {
  it('rechaza casa/PH (v1 calibrada para departamentos)', () => {
    expect(() => tasar({ ...base, tipoPropiedad: 'casa' })).toThrow(TasacionInputError);
  });
  it('rechaza sin m² cubiertos', () => {
    expect(() => tasar({ ...base, m2Cubiertos: null })).toThrow(TasacionInputError);
  });
});

describe('tasar — cálculo', () => {
  it('caso Palermo de referencia: valor coherente y trazable', () => {
    const r = tasar(base);
    // supHom = 75 + 8×0.33 = 77.64
    expect(r.superficieHomogeneizada).toBeCloseTo(77.64, 2);
    // sanity: depto 75m² Palermo debería caer en un rango plausible
    expect(r.valorEstimadoUsd).toBeGreaterThan(180_000);
    expect(r.valorEstimadoUsd).toBeLessThan(330_000);
    expect(r.valorEstimadoUsd % 100).toBe(0); // redondeo a centenas
    expect(r.rangoUsd[0]).toBeLessThan(r.valorEstimadoUsd);
    expect(r.rangoUsd[1]).toBeGreaterThan(r.valorEstimadoUsd);
    expect(r.confianza).toBe('alta');
    expect(r.fuentePrecios.fallback).toBe(false);
    expect(r.breakdown.length).toBeGreaterThan(5);
  });

  it('la cochera suma su valor de barrio', () => {
    const sin = tasar(base);
    const con = tasar({ ...base, tieneCochera: true });
    // 42500 × cAntiguedad(≈0.95) — la cochera entra antes del ajuste por antigüedad
    expect(con.valorEstimadoUsd - sin.valorEstimadoUsd).toBeGreaterThan(30_000);
    expect(con.valorEstimadoUsd - sin.valorEstimadoUsd).toBeLessThan(46_000);
  });

  it('contrafrente vale menos que frente', () => {
    const frente = tasar(base);
    const contra = tasar({ ...base, ubicacionPlanta: 'contrafrente' });
    expect(contra.valorEstimadoUsd).toBeLessThan(frente.valorEstimadoUsd);
  });

  it('más antigüedad y peor estado deprecian (solo componente construcción)', () => {
    const nuevo = tasar({ ...base, antiguedadAnios: 5, estadoConservacion: 1.0 });
    const viejo = tasar({ ...base, antiguedadAnios: 60, estadoConservacion: 3.0 });
    expect(viejo.valorEstimadoUsd).toBeLessThan(nuevo.valorEstimadoUsd);
    // 60 años NO destruye el valor (el suelo no deprecia): cae menos del 35%
    expect(viejo.valorEstimadoUsd).toBeGreaterThan(nuevo.valorEstimadoUsd * 0.65);
  });

  it('a estrenar aplica premio', () => {
    const usado = tasar(base);
    const estrenar = tasar({ ...base, antiguedadAnios: 0, estadoConservacion: 1.0, aEstrenar: true });
    expect(estrenar.valorEstimadoUsd).toBeGreaterThan(usado.valorEstimadoUsd);
  });

  it('barrio desconocido usa fallback CABA, baja confianza y lo declara', () => {
    const r = tasar({ ...base, barrio: 'Narnia' });
    expect(r.fuentePrecios.fallback).toBe(true);
    expect(r.confianza).toBe('baja');
  });

  it('datos faltantes aplican defaults documentados como supuestos y bajan confianza', () => {
    const r = tasar({ ...base, antiguedadAnios: null, estadoConservacion: null, piso: null, ubicacionPlanta: null });
    expect(r.supuestos.length).toBeGreaterThanOrEqual(3);
    expect(r.confianza).toBe('media'); // 100 −10 −10 −5 −5 = 70
  });

  it('clampea valores absurdos', () => {
    const r = tasar({ ...base, antiguedadAnios: 300 });
    expect(r.valorEstimadoUsd).toBeGreaterThan(0); // 300 → clamp 120 años
    expect(r.supuestos.some((s) => s.includes('120'))).toBe(true);
  });
});
