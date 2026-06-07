/** @jest-environment node */
import { expect } from '@jest/globals';
import type { SearchCriteria } from '~/types';
import { buildSearchUrls, slugify } from '../url';

const base: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo', 'Villa Crespo'],
  currency: 'ARS',
  mustHaves: [],
  niceToHaves: [],
  rawDescription: '',
};

describe('argenprop urls', () => {
  it('slugifies barrio names', () => {
    expect(slugify('Villa Crespo')).toBe('villa-crespo');
    expect(slugify('Núñez')).toBe('nunez');
  });

  it('builds one url per barrio', () => {
    expect(buildSearchUrls(base)).toEqual([
      'https://www.argenprop.com/departamentos/alquiler/palermo',
      'https://www.argenprop.com/departamentos/alquiler/villa-crespo',
    ]);
  });

  it('falls back to capital-federal when no barrios', () => {
    expect(buildSearchUrls({ ...base, barrios: [] })).toEqual([
      'https://www.argenprop.com/departamentos/alquiler/capital-federal',
    ]);
  });
});
