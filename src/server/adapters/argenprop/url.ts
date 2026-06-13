import type { SearchCriteria } from '~/types';

const BASE = 'https://www.argenprop.com';
const DEFAULT_PAGES = 5; // ~20 avisos por página → ~100 por barrio

const TYPE_SEGMENT: Record<SearchCriteria['propertyType'], string> = {
  departamento: 'departamentos',
  casa: 'casas',
  ph: 'ph',
};

export interface SearchTarget {
  url: string;
  barrio: string;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, '-');
}

/**
 * Una entrada por (barrio, página). Argenprop pagina con `?pagina-N` (la página 1 es la URL base).
 * Paginar amplía la cobertura para que una propiedad puntual no quede afuera por estar más abajo.
 */
export function buildSearchUrls(criteria: SearchCriteria, pages = DEFAULT_PAGES): SearchTarget[] {
  const tipo = TYPE_SEGMENT[criteria.propertyType];
  const barrios = criteria.barrios.length > 0 ? criteria.barrios : ['Capital Federal'];
  const targets: SearchTarget[] = [];
  for (const barrio of barrios) {
    const base = `${BASE}/${tipo}/${criteria.operation}/${slugify(barrio)}`;
    targets.push({ url: base, barrio });
    for (let p = 2; p <= pages; p++) targets.push({ url: `${base}?pagina-${p}`, barrio });
  }
  return targets;
}
