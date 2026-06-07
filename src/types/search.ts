export interface SearchCriteria {
  operation: 'alquiler' | 'venta';
  propertyType: 'departamento' | 'casa' | 'ph';
  barrios: string[]; // e.g. ['Palermo', 'Villa Crespo']
  priceMin?: number;
  priceMax?: number;
  currency: 'ARS' | 'USD';
  ambientesMin?: number;
  m2Min?: number;
  mustHaves: string[]; // e.g. ['balcón', 'apto mascotas']
  niceToHaves: string[];
  rawDescription: string;
}

export interface NormalizedListing {
  id: string; // sha1 of canonical URL
  url: string;
  portal: string;
  title: string;
  price: { amount: number; currency: 'ARS' | 'USD' };
  expensas?: number;
  barrio: string;
  ambientes?: number;
  m2?: number;
  features: string[];
  description: string; // truncated to ~150 words
  publishedAt?: string;
}

export type VerdictValue = 'match' | 'reject' | 'unsure';

export interface LensVerdict {
  id: string; // listing id
  verdict: VerdictValue;
  reason: string;
}

export interface Vote {
  lens: string;
  replica: number;
  verdicts: LensVerdict[];
}

export interface LensReason {
  lens: string;
  replica: number;
  verdict: VerdictValue;
  reason: string;
}

export interface ScoredListing {
  listing: NormalizedListing;
  score: number; // 0..1 over scoring lenses (red-flags excluded)
  matchedLenses: number;
  totalLenses: number;
  redFlag: boolean;
  reasons: LensReason[];
}

export type SearchPhase = 'intake' | 'acquisition' | 'voting' | 'consensus' | 'done' | 'error';

export type AdapterEventStatus = 'running' | 'ok' | 'blocked' | 'error';
export type AgentEventStatus = 'running' | 'ok' | 'error' | 'skipped';

export type SearchEvent =
  | { type: 'phase'; phase: SearchPhase }
  | { type: 'criteria'; criteria: SearchCriteria }
  | { type: 'adapter'; portal: string; status: AdapterEventStatus; count?: number; detail?: string }
  | { type: 'agent'; lens: string; replica: number; status: AgentEventStatus }
  | { type: 'tokens'; total: number; budget: number }
  | { type: 'done'; resultCount: number; degraded: boolean; partial: boolean }
  | { type: 'error'; message: string };

export interface SearchParams {
  description: string;
  replicas: number; // replicas per lens: 1 | 2 | 4
  threshold: number; // 0..1 fraction of scoring lenses that must match
  tokenBudget: number; // hard cap for the whole search
}
