import type { NormalizedListing } from '~/types';
import { normalizeMeliItem } from './normalize';
import { meliTokenManager } from './token';
import type { MeliItem } from './normalize';
import type { AdapterResult, PortalAdapter } from '../types';

const FETCH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 50;

// Categoría "Inmuebles Argentina" en el sitio MLA (Argentina)
const CATEGORY_ID = 'MLA1459';
const SITE_ID = 'MLA';

interface MeliSearchResponse {
  results: MeliItem[];
  paging: {
    total: number;
    offset: number;
    limit: number;
  };
}

async function fetchPage(url: string, token: string): Promise<{ data?: MeliSearchResponse; httpStatus: number }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { httpStatus: res.status };
  const data = (await res.json()) as MeliSearchResponse;
  return { data, httpStatus: res.status };
}

function buildSearchUrl(barrio: string, operation: string, propertyType: string, offset: number): string {
  // TODO (follow-up): filtrar por operation y propertyType vía IDs de attribute ML
  // (ej. OPERATION=242075 para alquiler, SUBTYPE para ph/casa/dpto).
  // Hoy usamos búsqueda libre por texto; funciona pero no filtra con precisión por tipo de inmueble.
  const q = `${barrio} ${operation} ${propertyType}`;
  return (
    `https://api.mercadolibre.com/sites/${SITE_ID}/search` +
    `?category=${CATEGORY_ID}` +
    `&q=${encodeURIComponent(q)}` +
    `&limit=${PAGE_SIZE}` +
    `&offset=${offset}`
  );
}

/**
 * Adapter de MercadoLibre usando la API oficial (OAuth Bearer token).
 * Solo se activa si las credenciales MELI_* están seteadas en el entorno.
 * NO implementa enrich() porque los attributes del search ya proveen datos estructurados.
 */
export const mercadolibreAdapter: PortalAdapter = {
  name: 'mercadolibre',
  tier: 'api',

  async search(criteria): Promise<AdapterResult> {
    const mgr = meliTokenManager;
    if (!mgr) {
      return { status: 'error', listings: [], detail: 'sin credenciales MELI' };
    }

    let token: string;
    try {
      token = await mgr.getAccessToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'error', listings: [], detail: `error obteniendo token MELI: ${msg}` };
    }

    const barrios = criteria.barrios.length > 0 ? criteria.barrios : ['Capital Federal'];
    const byId = new Map<string, NormalizedListing>();
    let errorCount = 0;

    for (const barrio of barrios) {
      // Traemos 2 páginas (~100 resultados) por barrio
      for (const offset of [0, PAGE_SIZE]) {
        const url = buildSearchUrl(barrio, criteria.operation, criteria.propertyType, offset);
        try {
          const { data } = await fetchPage(url, token);
          if (!data) {
            // 401 u otro error HTTP: no reintentamos refresh (el token se acaba de obtener)
            errorCount++;
            continue;
          }
          for (const item of data.results) {
            const listing = normalizeMeliItem(item, barrio);
            if (listing) byId.set(listing.id, listing);
          }
          // Si la primera página tiene menos resultados que PAGE_SIZE, no tiene sentido pedir la segunda
          if (offset === 0 && data.results.length < PAGE_SIZE) break;
        } catch {
          // timeout / network error
          errorCount++;
        }
      }
    }

    if (byId.size > 0) {
      return { status: 'ok', listings: [...byId.values()] };
    }

    const totalAttempts = barrios.length * 2; // 2 páginas por barrio
    if (errorCount >= totalAttempts) {
      return { status: 'error', listings: [], detail: 'todos los fetches a la API de MercadoLibre fallaron' };
    }

    // Sin resultados pero sin error total: ok con lista vacía (posible barrio sin resultados)
    return { status: 'ok', listings: [] };
  },
};
