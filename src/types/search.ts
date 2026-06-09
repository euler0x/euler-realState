// ---- Requisitos atómicos (salida del intake) ----
export type RequirementHardness = 'must' | 'nice';
export type RequirementKind = 'numeric' | 'textual';
export type NumericField = 'm2' | 'price' | 'ambientes' | 'expensas';
export type NumericOp = '>=' | '<=' | '==';

export interface NumericPredicate {
  field: NumericField;
  op: NumericOp;
  value: number;
}

export interface Requirement {
  id: string;
  label: string; // texto humano: "al menos 165 m²", "acepta mascotas"
  hardness: RequirementHardness;
  kind: RequirementKind;
  predicate?: NumericPredicate; // presente si kind === 'numeric'
  statement?: string; // presente si kind === 'textual': "el aviso indica que acepta mascotas"
  weight?: number; // peso del nice-to-have en el ranking (default 1)
}

export interface SearchCriteria {
  operation: 'alquiler' | 'venta';
  propertyType: 'departamento' | 'casa' | 'ph';
  barrios: string[];
  currency: 'ARS' | 'USD';
  requirements: Requirement[];
  rawDescription: string;
}

// ---- Listings ----
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
  description: string; // de la tarjeta, truncada ~150 palabras
  detailDescription?: string; // descripción completa de la página de detalle
  amenities?: string[]; // amenities de la página de detalle
  dataSource: 'card' | 'detail'; // 'card' si el detalle falló
  publishedAt?: string; // ISO 8601
}

// ---- Evaluación ----
export type Verdict = 'met' | 'not_met' | 'unknown';

export interface RequirementVerdict {
  requirementId: string;
  verdict: Verdict;
  evidence: string | null; // cita textual; obligatoria para 'met'
}

/** Resultado de UNA réplica textual sobre UN aviso. */
export interface Evaluation {
  listingId: string;
  replica: number;
  verdicts: RequirementVerdict[]; // solo requisitos textuales + red-flags
}

export interface EvaluatedListing {
  listing: NormalizedListing;
  passed: boolean;
  requirementResults: RequirementVerdict[]; // numéricos (código) + textuales (mayoría), por requirementId
  niceScore: number; // 0..1
  redFlag: boolean;
  partialData: boolean; // listing.dataSource === 'card'
}

export interface ExclusionBucket {
  reason: string;
  count: number;
  listingIds: string[];
}

export interface SearchOutput {
  survivors: EvaluatedListing[]; // ordenados: niceScore desc, luego precio asc
  exclusions: ExclusionBucket[];
  unevaluable: { listingId: string; error: string }[];
  degraded: boolean;
}

// ---- Eventos / progreso ----
export type SearchPhase = 'intake' | 'acquisition' | 'numeric_gate' | 'textual_eval' | 'ranking' | 'done' | 'error';
export type AdapterEventStatus = 'running' | 'ok' | 'blocked' | 'error';
export type AgentEventStatus = 'running' | 'ok' | 'error' | 'skipped';

export type SearchEvent =
  | { type: 'phase'; phase: SearchPhase }
  | { type: 'criteria'; criteria: SearchCriteria }
  | { type: 'adapter'; portal: string; status: AdapterEventStatus; count?: number; detail?: string }
  | { type: 'detail'; fetched: number; total: number } // progreso de fetch de detalle
  | { type: 'gate'; survived: number; total: number } // resultado del gate numérico
  | { type: 'eval'; listingId: string; replica: number; status: AgentEventStatus; detail?: string }
  | { type: 'tokens'; total: number; budget: number }
  | { type: 'done'; resultCount: number; degraded: boolean; partial: boolean }
  | { type: 'error'; message: string };

export interface SearchParams {
  description: string;
  replicas: number; // réplicas por aviso: 1 | 2 | 4
  tokenBudget: number; // tope duro de tokens
  criteria?: SearchCriteria; // si viene (editado por el usuario), se saltea el intake
}

export const RED_FLAGS_ID = '__redflags__';
