import type { NormalizedListing, SearchCriteria } from '~/types';

export type AdapterStatus = 'ok' | 'blocked' | 'error';

export interface AdapterResult {
  status: AdapterStatus;
  listings: NormalizedListing[];
  detail?: string;
}

export interface PortalAdapter {
  name: string;
  tier: 'api' | 'scraper' | 'agent';
  search(criteria: SearchCriteria): Promise<AdapterResult>;
  /**
   * Enriquece avisos con datos de detalle (descripción larga, amenities) que no vienen en el listado.
   * El orquestador la llama SOLO sobre los sobrevivientes del gate numérico. Opcional: los adapters
   * de API (ej. MercadoLibre) ya traen datos ricos y no la necesitan.
   */
  enrich?(listings: NormalizedListing[]): Promise<NormalizedListing[]>;
}
