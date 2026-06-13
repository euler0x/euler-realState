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

  it('builds paginated targets per barrio (page 1 = base url, then ?pagina-N)', () => {
    expect(buildSearchUrls(base, 2)).toEqual([
      { url: 'https://www.argenprop.com/departamentos/alquiler/palermo', barrio: 'Palermo' },
      { url: 'https://www.argenprop.com/departamentos/alquiler/palermo?pagina-2', barrio: 'Palermo' },
      { url: 'https://www.argenprop.com/departamentos/alquiler/villa-crespo', barrio: 'Villa Crespo' },
      { url: 'https://www.argenprop.com/departamentos/alquiler/villa-crespo?pagina-2', barrio: 'Villa Crespo' },
    ]);
  });

  it('falls back to capital-federal when no barrios', () => {
    expect(buildSearchUrls({ ...base, barrios: [] }, 1)).toEqual([
      { url: 'https://www.argenprop.com/departamentos/alquiler/capital-federal', barrio: 'Capital Federal' },
    ]);
  });

  it('maps casa and ph property types', () => {
    expect(buildSearchUrls({ ...base, propertyType: 'casa', barrios: ['Palermo'] }, 1)).toEqual([
      { url: 'https://www.argenprop.com/casas/alquiler/palermo', barrio: 'Palermo' },
    ]);
    expect(buildSearchUrls({ ...base, propertyType: 'ph', barrios: ['Palermo'] }, 1)).toEqual([
      { url: 'https://www.argenprop.com/ph/alquiler/palermo', barrio: 'Palermo' },
    ]);
  });
});
