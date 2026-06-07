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
}
