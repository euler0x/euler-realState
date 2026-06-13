import type { NormalizedListing } from '~/types';

export interface MeliAttribute {
  id: string;
  name?: string;
  value_name?: string | null;
  value_struct?: { number: number; unit: string } | null;
}

export interface MeliItem {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  permalink: string;
  address?: {
    city_name?: string;
    state_name?: string;
    neighborhood?: string;
  };
  attributes?: MeliAttribute[];
}

/**
 * Extrae un número de un attribute por su id.
 * Prioridad: value_struct.number → primer número de value_name.
 */
export function attrNumber(attrs: MeliAttribute[] | undefined, id: string): number | undefined {
  if (!attrs) return undefined;
  const attr = attrs.find((a) => a.id === id);
  if (!attr) return undefined;
  if (attr.value_struct != null && Number.isFinite(attr.value_struct.number)) {
    return attr.value_struct.number;
  }
  if (attr.value_name) {
    const m = attr.value_name.match(/(\d+(?:[.,]\d+)?)/);
    if (m) return parseFloat(m[1].replace(',', '.'));
  }
  return undefined;
}

/**
 * Normaliza un item del search de MercadoLibre a NormalizedListing.
 * Devuelve null si el item no tiene permalink o price válido.
 */
export function normalizeMeliItem(item: MeliItem, barrioFallback: string): NormalizedListing | null {
  if (!item.permalink) return null;
  if (!Number.isFinite(item.price) || item.price <= 0) return null;

  const attrs = item.attributes;

  // Ambientes: ROOMS tiene preferencia; si no hay, BEDROOMS + 1 (living)
  const rooms = attrNumber(attrs, 'ROOMS');
  const bedrooms = attrNumber(attrs, 'BEDROOMS');
  const ambientes: number | undefined = rooms !== undefined ? rooms : bedrooms !== undefined ? bedrooms + 1 : undefined;

  // m2: cubiertos tienen preferencia sobre total
  const m2 = attrNumber(attrs, 'COVERED_AREA') ?? attrNumber(attrs, 'TOTAL_AREA');

  // Expensas
  const expensas = attrNumber(attrs, 'MAINTENANCE_FEE');

  // Barrio
  const barrio = item.address?.neighborhood ?? item.address?.city_name ?? barrioFallback;

  // Features: value_name no nulo y no vacío de todos los attributes
  const features = (attrs ?? []).map((a) => a.value_name ?? '').filter((v) => v.trim().length > 0);

  // Descripción sintética a partir del título + features estructurados
  const description = [item.title, ...features].join(' · ');

  const currency: 'ARS' | 'USD' = item.currency_id === 'USD' ? 'USD' : 'ARS';

  return {
    id: `meli-${item.id}`,
    url: item.permalink,
    portal: 'mercadolibre',
    title: item.title,
    price: { amount: item.price, currency },
    expensas,
    barrio,
    ambientes,
    m2,
    features,
    description,
    // Los attributes del search de ML son datos estructurados, equivalentes a una página de detalle
    dataSource: 'detail' as const,
  };
}
