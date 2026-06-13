/** @jest-environment node */
import { expect } from '@jest/globals';
import type { TasacionInput, UbicacionInfo } from '~/types';
import { derivarMejoras } from '../mejoras';

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
