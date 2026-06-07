import type { SearchCriteria } from '~/types';

const BASE = 'https://www.argenprop.com';

const TYPE_SEGMENT: Record<SearchCriteria['propertyType'], string> = {
  departamento: 'departamentos',
  casa: 'casas',
  ph: 'ph',
};

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, '-');
}

export function buildSearchUrls(criteria: SearchCriteria): string[] {
  const tipo = TYPE_SEGMENT[criteria.propertyType];
  const barrios = criteria.barrios.length > 0 ? criteria.barrios : ['Capital Federal'];
  return barrios.map((b) => `${BASE}/${tipo}/${criteria.operation}/${slugify(b)}`);
}
