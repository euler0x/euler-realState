# Búsqueda de calidad (gates + rigor) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reemplazar el núcleo de matching del MVP (votos blandos por lentes genéricos + score fraccional) por **gates duros (numéricos en código + textuales LLM con evidencia obligatoria) + ranking por nice-to-haves**, sobre un pool enriquecido con la página de detalle de cada aviso.

**Architecture:** Pipeline: intake (Sonnet) descompone la descripción en `Requirement[]` atómicos (must/nice, numeric/textual) → adquisición abre el detalle de cada aviso → gates numéricos en código filtran (estricto) → evaluador Haiku confirma cada requisito textual con cita obligatoria (réplicas, mayoría) → ranking de sobrevivientes por nice-to-haves + buckets de exclusión. Spec: `docs/superpowers/specs/2026-06-09-busqueda-calidad-gates-rigor-design.md`.

**Tech Stack:** Next.js 15 App Router, TypeScript, MUI, better-sqlite3, cheerio, @anthropic-ai/claude-agent-sdk (dynamic import, json_schema), Jest. Branch: `feat/busqueda-calidad`.

**Reusa del MVP (no se reescribe):** SQLite (`db.ts` se extiende), eventos SSE (`events.ts` intacto), patrón de adapters, patrón de agente con SDK (lazy `getQuery`, `tokensFromUsage`, `stableStringify` — se mueven a un módulo compartido en Task 5), circuit breaker de tokens con reservación.

**Reemplaza:** `consensus.ts` → `ranking.ts`; `llm/vote.ts` + `llm/lenses.ts` → `llm/evaluate.ts` (lente `holistico` se elimina; `red-flags` pasa a ser un check inyectado marcador).

**Costo de verificación:** solo Task 11 (smoke e2e) y opcionalmente Task 4 (smoke intake) consumen cuota real. El resto corre con mocks/fixtures.

---

### Task 1: Tipos v2

**Files:**
- Modify: `src/types/search.ts` (reescritura completa de los tipos de dominio)

- [ ] **Step 1: Reescribir `src/types/search.ts`** con exactamente:

```ts
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
```

- [ ] **Step 2: Verificar que TODO lo viejo dejó de compilar (esperado)** — los módulos `consensus.ts`, `vote.ts`, `lenses.ts`, `search.ts`, `db.ts`, UI van a romper porque cambiaron los tipos. Es esperado; se arreglan en sus tasks. Para que el repo compile entre tasks, este task NO corre build aún.

Run: `pnpm run lint 2>&1 | head -5` (va a haber errores en consumidores — OK, se resuelven en orden)

- [ ] **Step 3: Commit**

```bash
git add src/types/search.ts
git commit -m "feat: domain types v2 (requirements, gates, evaluation)"
```

> Nota para el ejecutor: a partir de acá el repo queda temporalmente roto hasta Task 10. Cada task arregla su parte. Las tasks de lógica pura (4,6,7) se pueden testear aisladas con `pnpm run test:unit -- <archivo>` aunque el resto no compile, porque Jest compila por archivo.

---

### Task 2: Módulo SDK compartido

Extraer el patrón duplicado (lazy `getQuery`, `tokensFromUsage`, `Usage`, `stableStringify`) a un módulo único, para que intake y evaluate lo reusen.

**Files:**
- Create: `src/server/llm/sdk.ts`
- Test: `src/server/llm/__tests__/sdk.test.ts`

- [ ] **Step 1: Test que falla** — `src/server/llm/__tests__/sdk.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { tokensFromUsage, stableStringify } from '../sdk';

describe('tokensFromUsage', () => {
  it('sums input, output and cache_creation; ignores cache reads', () => {
    expect(
      tokensFromUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 100 }),
    ).toBe(6);
    expect(tokensFromUsage({})).toBe(0);
  });
});

describe('stableStringify', () => {
  it('produces byte-identical output regardless of key insertion order', () => {
    const a = stableStringify({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = stableStringify({ a: 2, b: 1, nested: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });
  it('preserves arrays in order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});
```

Run: `pnpm run test:unit -- llm/__tests__/sdk` → FAIL.

- [ ] **Step 2: Implementar `src/server/llm/sdk.ts`**

```ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Memoized async accessor: resolves `query` via lazy dynamic import on first call.
 * Kept lazy so jest.mock() intercepts it in CJS transform mode (next/jest) and
 * so the SDK stays a runtime external (not bundled by webpack).
 */
export type SdkModule = { query: (...args: unknown[]) => AsyncIterable<SDKMessage> };
let _sdk: SdkModule | undefined;
export async function getQuery() {
  if (!_sdk) {
    _sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SdkModule;
  }
  return _sdk.query;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Cache reads cost ~10%; count the expensive components only. */
export function tokensFromUsage(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** Deterministic JSON: sorted keys so the cached prefix is byte-identical across replicas/runs. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
```

Re-export `SDKMessage` type usage stays via the package. (Type-only `import type { SDKMessage }` does not break the jest.mock/runtime pattern.)

- [ ] **Step 3:** Run `pnpm run test:unit -- llm/__tests__/sdk` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/llm/sdk.ts src/server/llm/__tests__/sdk.test.ts
git commit -m "refactor: shared sdk helpers (getQuery, tokensFromUsage, stableStringify)"
```

---

### Task 3: Intake v2 — descomposición en requisitos

**Files:**
- Modify: `src/server/llm/intake.ts`
- Test: `src/server/llm/__tests__/intake.test.ts` (reescribir)

- [ ] **Step 1: Reescribir el test** — `src/server/llm/__tests__/intake.test.ts`:

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

// eslint-disable-next-line import/first
import { runIntake } from '../intake';

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('runIntake', () => {
  beforeEach(() => mockQuery.mockReset());

  it('parses description into base criteria + atomic requirements', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        {
          type: 'result',
          subtype: 'success',
          structured_output: {
            operation: 'alquiler',
            propertyType: 'departamento',
            barrios: ['Palermo'],
            currency: 'ARS',
            requirements: [
              { id: 'r1', label: 'al menos 165 m²', hardness: 'must', kind: 'numeric', predicate: { field: 'm2', op: '>=', value: 165 } },
              { id: 'r2', label: 'acepta mascotas', hardness: 'must', kind: 'textual', statement: 'el aviso indica que acepta mascotas' },
              { id: 'r3', label: 'luminoso', hardness: 'nice', kind: 'textual', statement: 'el aviso menciona que es luminoso', weight: 1 },
            ],
          },
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      ]),
    );
    const { criteria, tokens } = await runIntake('depto en palermo, mínimo 165 m2, que acepte mascotas, ojalá luminoso');
    expect(criteria.operation).toBe('alquiler');
    expect(criteria.rawDescription).toContain('palermo');
    expect(criteria.requirements).toHaveLength(3);
    expect(criteria.requirements[0].predicate).toEqual({ field: 'm2', op: '>=', value: 165 });
    expect(criteria.requirements[1].hardness).toBe('must');
    expect(tokens).toBe(80);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('throws on failure subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution', usage: {} }]));
    await expect(runIntake('x')).rejects.toThrow(/intake failed/);
  });
});
```

Run: `pnpm run test:unit -- llm/__tests__/intake` → FAIL.

- [ ] **Step 2: Reescribir `src/server/llm/intake.ts`**

```ts
import { getQuery, tokensFromUsage, type Usage } from './sdk';
import type { SearchCriteria } from '~/types';

export const INTAKE_MODEL = 'claude-sonnet-4-6';
const INTAKE_MAX_TURNS = 2; // structured output necesita >1 turno

const REQUIREMENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    hardness: { type: 'string', enum: ['must', 'nice'] },
    kind: { type: 'string', enum: ['numeric', 'textual'] },
    predicate: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: ['m2', 'price', 'ambientes', 'expensas'] },
        op: { type: 'string', enum: ['>=', '<=', '=='] },
        value: { type: 'number' },
      },
      required: ['field', 'op', 'value'],
      additionalProperties: false,
    },
    statement: { type: 'string' },
    weight: { type: 'number' },
  },
  required: ['id', 'label', 'hardness', 'kind'],
  additionalProperties: false,
} as const;

const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['alquiler', 'venta'] },
    propertyType: { type: 'string', enum: ['departamento', 'casa', 'ph'] },
    barrios: { type: 'array', items: { type: 'string' } },
    currency: { type: 'string', enum: ['ARS', 'USD'] },
    requirements: { type: 'array', items: REQUIREMENT_SCHEMA },
  },
  required: ['operation', 'propertyType', 'barrios', 'currency', 'requirements'],
  additionalProperties: false,
} as const;

const INTAKE_PROMPT = `Sos un parser de búsquedas inmobiliarias de Buenos Aires. Convertí la descripción libre en criterios estructurados y una lista de REQUISITOS ATÓMICOS.

Reglas:
- "barrios": barrios de CABA/GBA mencionados o implicados (capitalizados). Vacío si no menciona zona.
- Cada requisito es UNA cosa concreta. Asignale:
  - "hardness": "must" si es innegociable (lenguaje: "al menos / mínimo / sí o sí / necesito / imprescindible", o cualquier requisito cuantificado concreto como m²/precio/dormitorios). "nice" si es un deseo blando ("ojalá / preferiblemente / estaría bueno", adjetivos como "luminoso/moderno").
  - "kind": "numeric" si se puede comparar con un número del aviso (m², precio, ambientes, expensas) → completá "predicate" {field, op, value}. Usá ">=" para mínimos ("al menos 165 m²", "3 dormitorios"), "<=" para topes ("hasta 900 mil"). "textual" para todo lo demás → completá "statement" (una afirmación a confirmar en el aviso, ej. "el aviso indica que acepta mascotas").
  - "id": un slug corto único (r1, r2, ...).
  - "weight" (solo nice): 1 por default; subilo a 2-3 si el usuario enfatizó ese deseo.
- "operation": si no se aclara, "alquiler". "propertyType": si no se aclara, "departamento". "currency": ARS para alquiler, USD para venta si no se aclara.

DESCRIPCIÓN:
`;

export async function runIntake(description: string): Promise<{ criteria: SearchCriteria; tokens: number }> {
  const query = await getQuery();
  for await (const message of query({
    prompt: `${INTAKE_PROMPT}${description}`,
    options: {
      model: INTAKE_MODEL,
      maxTurns: INTAKE_MAX_TURNS,
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: CRITERIA_SCHEMA as Record<string, unknown> },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || !message.structured_output) {
        throw new Error(`intake failed: ${message.subtype}`);
      }
      const parsed = message.structured_output as Omit<SearchCriteria, 'rawDescription'>;
      return { criteria: { ...parsed, rawDescription: description }, tokens: tokensFromUsage(message.usage as Usage) };
    }
  }
  throw new Error('intake failed: stream ended without result');
}
```

- [ ] **Step 3:** Run `pnpm run test:unit -- llm/__tests__/intake` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/llm/intake.ts src/server/llm/__tests__/intake.test.ts
git commit -m "feat: intake v2 decomposes description into atomic requirements"
```

---

### Task 4: (opcional) Smoke real del intake

Consume cuota (~5-10k Sonnet). Verifica que el intake real produce requisitos sensatos. **El ejecutor puede saltearlo** si quiere conservar cuota; el smoke e2e (Task 11) lo cubre igual.

- [ ] **Step 1:** Crear `scripts/smoke-intake.ts` temporal (no commitear):

```ts
import { runIntake } from '../src/server/llm/intake';
runIntake('Depto en alquiler en Palermo o Villa Crespo, mínimo 165 m2, 3 dormitorios, que acepte mascotas, hasta 1200 dólares, ojalá con mesada de mármol y luminoso')
  .then((r) => console.log(JSON.stringify(r.criteria.requirements, null, 2)));
```

Run: `npx tsx scripts/smoke-intake.ts` (timeout 180000ms). Verificar que m²/dormitorios/precio salen como `numeric` con predicado, mascotas/mármol/luminoso como `textual`, y que el `>=165` está bien. Luego `rm scripts/smoke-intake.ts`.

---

### Task 5: Validación de evidencia (código puro, TDD)

**Files:**
- Create: `src/server/evidence.ts`
- Test: `src/server/__tests__/evidence.test.ts`

- [ ] **Step 1: Test que falla** — `src/server/__tests__/evidence.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { evidenceAppearsIn } from '../evidence';

describe('evidenceAppearsIn', () => {
  const text = 'Hermoso depto LUMINOSO, apto  mascotas, mesada de mármol Carrara.';

  it('matches a substring ignoring case and collapsing whitespace', () => {
    expect(evidenceAppearsIn('apto mascotas', text)).toBe(true); // doble espacio en el texto colapsa
    expect(evidenceAppearsIn('luminoso', text)).toBe(true);
    expect(evidenceAppearsIn('mesada de mármol', text)).toBe(true);
  });

  it('rejects a quote not present in the text', () => {
    expect(evidenceAppearsIn('pileta climatizada', text)).toBe(false);
  });

  it('rejects null/empty evidence', () => {
    expect(evidenceAppearsIn(null, text)).toBe(false);
    expect(evidenceAppearsIn('   ', text)).toBe(false);
  });
});
```

Run: `pnpm run test:unit -- __tests__/evidence` → FAIL.

- [ ] **Step 2: Implementar `src/server/evidence.ts`**

```ts
/** Normaliza para comparar: lowercase + colapsa espacios. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Anti-alucinación: una cita de evidencia solo es válida si aparece (normalizada)
 * como substring del texto del aviso. Cita vacía/null → inválida.
 */
export function evidenceAppearsIn(evidence: string | null, listingText: string): boolean {
  if (!evidence || !evidence.trim()) return false;
  return normalize(listingText).includes(normalize(evidence));
}
```

- [ ] **Step 3:** Run `pnpm run test:unit -- __tests__/evidence` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/evidence.ts src/server/__tests__/evidence.test.ts
git commit -m "feat: evidence substring validation (anti-hallucination)"
```

---

### Task 6: Gates numéricos (código puro, TDD)

**Files:**
- Create: `src/server/gates.ts`
- Test: `src/server/__tests__/gates.test.ts`

- [ ] **Step 1: Test que falla** — `src/server/__tests__/gates.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { applyNumericGates } from '../gates';
import type { NormalizedListing, Requirement } from '~/types';

const listing = (over: Partial<NormalizedListing>): NormalizedListing => ({
  id: 'l1',
  url: 'https://x/1',
  portal: 'argenprop',
  title: 'd',
  price: { amount: 500_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: '',
  dataSource: 'detail',
  ...over,
});

const m2min: Requirement = { id: 'r1', label: '≥165 m²', hardness: 'must', kind: 'numeric', predicate: { field: 'm2', op: '>=', value: 165 } };
const priceMax: Requirement = { id: 'r2', label: '≤900k', hardness: 'must', kind: 'numeric', predicate: { field: 'price', op: '<=', value: 900_000 } };
const niceM2: Requirement = { id: 'r3', label: '≥200 m²', hardness: 'nice', kind: 'numeric', predicate: { field: 'm2', op: '>=', value: 200 } };

describe('applyNumericGates', () => {
  it('passes a listing that satisfies all hard numeric must-haves', () => {
    const r = applyNumericGates(listing({ m2: 180 }), [m2min, priceMax]);
    expect(r.passed).toBe(true);
    expect(r.verdicts.find((v) => v.requirementId === 'r1')?.verdict).toBe('met');
  });

  it('fails strict when the value violates the predicate', () => {
    const r = applyNumericGates(listing({ m2: 50 }), [m2min]);
    expect(r.passed).toBe(false);
    expect(r.failReason).toMatch(/50.*165|165/);
    expect(r.verdicts[0].verdict).toBe('not_met');
  });

  it('fails strict when the field is missing (no informado)', () => {
    const r = applyNumericGates(listing({ m2: undefined }), [m2min]);
    expect(r.passed).toBe(false);
    expect(r.failReason).toMatch(/no informado/i);
    expect(r.verdicts[0].verdict).toBe('unknown');
  });

  it('reads price from listing.price.amount and expensas from listing.expensas', () => {
    expect(applyNumericGates(listing({ price: { amount: 950_000, currency: 'ARS' } }), [priceMax]).passed).toBe(false);
    expect(applyNumericGates(listing({ price: { amount: 800_000, currency: 'ARS' } }), [priceMax]).passed).toBe(true);
  });

  it('ignores numeric NICE requirements for the gate but evaluates them as verdicts', () => {
    const r = applyNumericGates(listing({ m2: 180 }), [m2min, niceM2]);
    expect(r.passed).toBe(true); // niceM2 (≥200) no cumple pero NO bloquea (es nice)
    expect(r.verdicts.find((v) => v.requirementId === 'r3')?.verdict).toBe('not_met');
  });

  it('ignores textual requirements entirely', () => {
    const textual: Requirement = { id: 'r9', label: 'mascotas', hardness: 'must', kind: 'textual', statement: 's' };
    const r = applyNumericGates(listing({ m2: 180 }), [m2min, textual]);
    expect(r.passed).toBe(true);
    expect(r.verdicts.find((v) => v.requirementId === 'r9')).toBeUndefined(); // textual no se evalúa acá
  });
});
```

Run: `pnpm run test:unit -- __tests__/gates` → FAIL.

- [ ] **Step 2: Implementar `src/server/gates.ts`**

```ts
import type { NormalizedListing, NumericField, NumericOp, Requirement, RequirementVerdict } from '~/types';

function fieldValue(listing: NormalizedListing, field: NumericField): number | undefined {
  switch (field) {
    case 'm2':
      return listing.m2;
    case 'ambientes':
      return listing.ambientes;
    case 'price':
      return listing.price.amount;
    case 'expensas':
      return listing.expensas;
  }
}

function compare(value: number, op: NumericOp, target: number): boolean {
  if (op === '>=') return value >= target;
  if (op === '<=') return value <= target;
  return value === target;
}

const FIELD_LABEL: Record<NumericField, string> = { m2: 'm²', price: 'precio', ambientes: 'ambientes', expensas: 'expensas' };

export interface NumericGateResult {
  passed: boolean; // false si algún must-have numérico no se cumple
  failReason?: string; // motivo del primer must-have que falló (para el bucket de exclusión)
  verdicts: RequirementVerdict[]; // un verdict por requisito numérico (must y nice)
}

/**
 * Evalúa los requisitos NUMÉRICOS de un aviso. Los must-have numéricos actúan como gate duro
 * (estricto: dato faltante → unknown → no pasa). Los nice-to-have numéricos se evalúan como
 * verdicts (para el ranking) pero nunca bloquean. Los requisitos textuales se ignoran acá.
 */
export function applyNumericGates(listing: NormalizedListing, requirements: Requirement[]): NumericGateResult {
  const verdicts: RequirementVerdict[] = [];
  let passed = true;
  let failReason: string | undefined;

  for (const req of requirements) {
    if (req.kind !== 'numeric' || !req.predicate) continue;
    const { field, op, value } = req.predicate;
    const actual = fieldValue(listing, field);
    let verdict: RequirementVerdict['verdict'];
    if (actual === undefined) {
      verdict = 'unknown';
    } else {
      verdict = compare(actual, op, value) ? 'met' : 'not_met';
    }
    verdicts.push({ requirementId: req.id, verdict, evidence: actual === undefined ? null : `${actual}` });

    if (req.hardness === 'must' && verdict !== 'met' && passed) {
      passed = false;
      failReason =
        verdict === 'unknown'
          ? `${FIELD_LABEL[field]} no informado`
          : `${FIELD_LABEL[field]} ${actual} no cumple ${op} ${value}`;
    }
  }

  return { passed, failReason, verdicts };
}
```

- [ ] **Step 3:** Run `pnpm run test:unit -- __tests__/gates` → PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add src/server/gates.ts src/server/__tests__/gates.test.ts
git commit -m "feat: numeric hard gates (strict, deterministic)"
```

---

### Task 7: Evaluador textual (LLM con evidencia, TDD mock)

Reemplaza `vote.ts`. Evalúa UNA réplica sobre UN aviso: confirma cada requisito textual (+ un check fijo de red-flags) con evidencia.

**Files:**
- Create: `src/server/llm/evaluate.ts`
- Test: `src/server/llm/__tests__/evaluate.test.ts`
- Delete: `src/server/llm/vote.ts`, `src/server/llm/lenses.ts` y sus tests (`__tests__/vote.test.ts`) — Step 6.

- [ ] **Step 1: Test que falla** — `src/server/llm/__tests__/evaluate.test.ts`:

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

// eslint-disable-next-line import/first
import { buildEvaluatePrompt, runEvaluator, EVALUATE_MODEL } from '../evaluate';
// eslint-disable-next-line import/first
import type { NormalizedListing, Requirement } from '~/types';
// eslint-disable-next-line import/first
import { RED_FLAGS_ID } from '~/types';

const listing: NormalizedListing = {
  id: 'l1',
  url: 'https://x/1',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 800_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'Luminoso, apto mascotas',
  detailDescription: 'Hermoso departamento luminoso, apto mascotas, mesada de mármol.',
  dataSource: 'detail',
};

const textualReqs: Requirement[] = [
  { id: 'r2', label: 'acepta mascotas', hardness: 'must', kind: 'textual', statement: 'el aviso indica que acepta mascotas' },
  { id: 'r3', label: 'luminoso', hardness: 'nice', kind: 'textual', statement: 'el aviso menciona que es luminoso' },
];

function resultMessage(verdicts: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return { type: 'result', subtype: 'success', structured_output: { verdicts }, usage };
}
function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('buildEvaluatePrompt', () => {
  it('includes the listing text, the textual requirements, and a red-flags instruction', () => {
    const p = buildEvaluatePrompt(listing, textualReqs);
    expect(p).toContain('apto mascotas');
    expect(p).toContain('r2');
    expect(p).toContain(RED_FLAGS_ID);
  });
});

describe('runEvaluator', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns one verdict per textual requirement and tokens', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        resultMessage([
          { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
          { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
          { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
        ]),
      ]),
    );
    const { evaluation, tokens } = await runEvaluator({ listing, requirements: textualReqs, replica: 1 });
    expect(evaluation.listingId).toBe('l1');
    expect(evaluation.replica).toBe(1);
    expect(evaluation.verdicts).toHaveLength(3);
    expect(tokens).toBe(120);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe(EVALUATE_MODEL);
    expect(opts.maxTurns).toBe(4);
  });

  it('throws on non-success subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_max_turns', usage: {} }]));
    await expect(runEvaluator({ listing, requirements: textualReqs, replica: 1 })).rejects.toThrow(/error_max_turns/);
  });

  it('throws when structured_output.verdicts is not an array', async () => {
    mockQuery.mockReturnValue(asyncGen([resultMessage(null)]));
    await expect(runEvaluator({ listing, requirements: textualReqs, replica: 1 })).rejects.toThrow(/not an array/);
  });
});
```

Run: `pnpm run test:unit -- llm/__tests__/evaluate` → FAIL.

- [ ] **Step 2: Implementar `src/server/llm/evaluate.ts`**

```ts
import { getQuery, stableStringify, tokensFromUsage, type Usage } from './sdk';
import { RED_FLAGS_ID, type Evaluation, type NormalizedListing, type Requirement, type RequirementVerdict } from '~/types';

export const EVALUATE_MODEL = 'claude-haiku-4-5';
const AGENT_TIMEOUT_MS = 90_000;
const EVALUATE_MAX_TURNS = 4; // structured output sobre payload grande necesita varios turnos

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirementId: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'not_met', 'unknown'] },
          evidence: { type: ['string', 'null'] },
        },
        required: ['requirementId', 'verdict', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

function listingText(listing: NormalizedListing): string {
  return [listing.title, listing.detailDescription ?? listing.description, (listing.amenities ?? []).join(', ')]
    .filter(Boolean)
    .join('\n');
}

export function buildEvaluatePrompt(listing: NormalizedListing, requirements: Requirement[]): string {
  const reqList = requirements
    .filter((r) => r.kind === 'textual')
    .map((r) => ({ id: r.id, statement: r.statement }));
  const text = listingText(listing);
  return [
    'Sos un verificador estricto de avisos inmobiliarios de Buenos Aires. Para CADA requisito, decidí si el aviso lo cumple, CITANDO el fragmento textual del aviso que lo confirma.',
    'Reglas:',
    '- verdict "met" SOLO si el texto del aviso lo confirma, y "evidence" DEBE ser la cita textual exacta del aviso (copiada, no parafraseada).',
    '- verdict "not_met" si el aviso lo contradice. verdict "unknown" si el aviso no dice nada al respecto (NO inventes).',
    '- Si no podés citar evidencia textual, NO uses "met".',
    `- Además, evaluá un requisito especial con id "${RED_FLAGS_ID}": verdict "met" si detectás RED FLAGS (precio sospechosamente bajo, descripción vaga/genérica, datos contradictorios), "not_met" si parece confiable, "unknown" si no hay info. La evidencia es la señal que viste.`,
    '',
    `REQUISITOS (JSON):\n${stableStringify(reqList)}`,
    '',
    `AVISO:\n${text}`,
    '',
    `Devolvé un verdict por cada requisito de la lista MÁS uno para "${RED_FLAGS_ID}".`,
  ].join('\n');
}

export interface EvaluatorArgs {
  listing: NormalizedListing;
  requirements: Requirement[];
  replica: number;
  model?: string;
  timeoutMs?: number;
}

export async function runEvaluator(args: EvaluatorArgs): Promise<{ evaluation: Evaluation; tokens: number }> {
  const { listing, requirements, replica, model = EVALUATE_MODEL, timeoutMs = AGENT_TIMEOUT_MS } = args;
  const query = await getQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    for await (const message of query({
      prompt: buildEvaluatePrompt(listing, requirements),
      options: {
        model,
        maxTurns: EVALUATE_MAX_TURNS,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: VERDICTS_SCHEMA as Record<string, unknown> },
      },
    })) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || !message.structured_output) {
          throw new Error(`evaluator l=${listing.id}#${replica} failed: ${message.subtype}`);
        }
        const { verdicts } = message.structured_output as { verdicts: RequirementVerdict[] };
        if (!Array.isArray(verdicts)) {
          throw new Error(`evaluator l=${listing.id}#${replica}: invalid structured_output — verdicts is not an array`);
        }
        return { evaluation: { listingId: listing.id, replica, verdicts }, tokens: tokensFromUsage(message.usage as Usage) };
      }
    }
    throw new Error(`evaluator l=${listing.id}#${replica}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 3:** Run `pnpm run test:unit -- llm/__tests__/evaluate` → PASS.

- [ ] **Step 4: Eliminar los módulos viejos**

```bash
git rm src/server/llm/vote.ts src/server/llm/lenses.ts src/server/llm/__tests__/vote.test.ts
```

(Intake ya no importa de `vote.ts` — Task 3 lo movió a `sdk.ts`. Verificá con `grep -rn "llm/vote\|llm/lenses" src/` que no queden imports; si `search.ts` aún importa, se arregla en Task 9.)

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/evaluate.ts src/server/llm/__tests__/evaluate.test.ts
git commit -m "feat: textual evaluator with mandatory evidence; remove lens voting"
```

---

### Task 8: Ranking + combinación (código puro, TDD)

Reemplaza `consensus.ts`. Combina gate numérico + veredictos textuales (mayoría entre réplicas + validación de evidencia) → `SearchOutput`.

**Files:**
- Create: `src/server/ranking.ts`
- Test: `src/server/__tests__/ranking.test.ts`
- Delete: `src/server/consensus.ts`, `src/server/__tests__/consensus.test.ts` — Step 4.

- [ ] **Step 1: Test que falla** — `src/server/__tests__/ranking.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { rankResults, type GatedListing } from '../ranking';
import { RED_FLAGS_ID, type Evaluation, type NormalizedListing, type Requirement } from '~/types';

const mk = (id: string, over: Partial<NormalizedListing> = {}): NormalizedListing => ({
  id,
  url: `https://x/${id}`,
  portal: 'argenprop',
  title: `d${id}`,
  price: { amount: 500_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'apto mascotas, luminoso',
  detailDescription: 'apto mascotas, luminoso',
  dataSource: 'detail',
  ...over,
});

const reqMascotas: Requirement = { id: 'r2', label: 'mascotas', hardness: 'must', kind: 'textual', statement: 's' };
const reqLum: Requirement = { id: 'r3', label: 'luminoso', hardness: 'nice', kind: 'textual', statement: 's', weight: 1 };
const reqCochera: Requirement = { id: 'r4', label: 'cochera', hardness: 'nice', kind: 'textual', statement: 's', weight: 2 };
const reqs = [reqMascotas, reqLum, reqCochera];

const ev = (listingId: string, replica: number, verdicts: Evaluation['verdicts']): Evaluation => ({ listingId, replica, verdicts });

describe('rankResults', () => {
  it('excludes a listing whose hard textual must-have is not confirmed (strict)', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      // r2 (mascotas, must) viene 'met' pero la evidencia NO está en el texto → degrada a unknown → excluye
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'jacuzzi inexistente' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
      ]),
    ];
    const out = rankResults(gated, evals, reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(0);
    expect(out.exclusions.some((b) => b.listingIds.includes('a'))).toBe(true);
  });

  it('keeps a listing whose hard must-have is confirmed with valid evidence, scores nice-to-haves', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' }, // substring real
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' }, // nice peso 1 → cumple
        { requirementId: 'r4', verdict: 'not_met', evidence: null }, // cochera nice peso 2 → no cumple
        { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
      ]),
    ];
    const out = rankResults(gated, evals, reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(1);
    // niceScore = peso cumplido (1) / peso total nice (1+2=3) = 0.333...
    expect(out.survivors[0].niceScore).toBeCloseTo(1 / 3, 3);
  });

  it('resolves replica majority per requirement (2 of 3 met with evidence → met)', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      ev('a', 1, [{ requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' }]),
      ev('a', 2, [{ requirementId: 'r2', verdict: 'not_met', evidence: null }]),
      ev('a', 3, [{ requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' }]),
    ];
    const out = rankResults(gated, evals, [reqMascotas], { replicas: 3 });
    expect(out.survivors).toHaveLength(1); // 2/3 met → pasa
  });

  it('propagates a numeric gate failure into an exclusion bucket', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: 'm² 50 no cumple >= 165' }];
    const out = rankResults(gated, [], reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(0);
    expect(out.exclusions.find((b) => b.reason === 'm² 50 no cumple >= 165')?.count).toBe(1);
  });

  it('sets redFlag from the special check and marks partialData', () => {
    const gated: GatedListing[] = [{ listing: mk('a', { dataSource: 'card' }), numericVerdicts: [], failReason: undefined }];
    const evals = [
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
        { requirementId: RED_FLAGS_ID, verdict: 'met', evidence: 'precio muy bajo' },
      ]),
    ];
    const out = rankResults(gated, evals, [reqMascotas], { replicas: 1 });
    expect(out.survivors[0].redFlag).toBe(true);
    expect(out.survivors[0].partialData).toBe(true);
  });

  it('orders survivors by niceScore desc then price asc', () => {
    const gated: GatedListing[] = [
      { listing: mk('a', { price: { amount: 700_000, currency: 'ARS' } }), numericVerdicts: [], failReason: undefined },
      { listing: mk('b', { price: { amount: 500_000, currency: 'ARS' } }), numericVerdicts: [], failReason: undefined },
    ];
    // ambos cumplen el must y mismo niceScore → desempata precio asc → b antes que a
    const mkEval = (id: string) =>
      ev(id, 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: 'r4', verdict: 'not_met', evidence: null },
      ]);
    const out = rankResults(gated, [mkEval('a'), mkEval('b')], reqs, { replicas: 1 });
    expect(out.survivors.map((s) => s.listing.id)).toEqual(['b', 'a']);
  });
});
```

Run: `pnpm run test:unit -- __tests__/ranking` → FAIL.

- [ ] **Step 2: Implementar `src/server/ranking.ts`**

```ts
import { evidenceAppearsIn } from './evidence';
import {
  RED_FLAGS_ID,
  type EvaluatedListing,
  type Evaluation,
  type ExclusionBucket,
  type NormalizedListing,
  type Requirement,
  type RequirementVerdict,
  type SearchOutput,
  type Verdict,
} from '~/types';

/** Un aviso que ya pasó (o no) el gate numérico, listo para combinar con los veredictos textuales. */
export interface GatedListing {
  listing: NormalizedListing;
  numericVerdicts: RequirementVerdict[]; // de applyNumericGates (must + nice numéricos)
  failReason?: string; // motivo si el gate numérico lo descartó
}

export interface RankOptions {
  replicas: number;
}

function listingText(l: NormalizedListing): string {
  return [l.title, l.detailDescription ?? l.description, (l.amenities ?? []).join(', ')].filter(Boolean).join('\n');
}

/**
 * Mayoría entre réplicas para un requisito. Empate o sin datos → 'unknown'.
 * `requireEvidence`: para requisitos del usuario un 'met' solo cuenta si la cita aparece en el
 * texto (anti-alucinación). Para el check de red-flags es `false`, porque un red flag es un
 * juicio ("precio sospechosamente bajo"), no una cita literal del aviso.
 */
function majorityVerdict(
  reqId: string,
  evals: Evaluation[],
  text: string,
  requireEvidence = true,
): { verdict: Verdict; evidence: string | null } {
  let met = 0;
  let notMet = 0;
  let evidence: string | null = null;
  for (const e of evals) {
    const v = e.verdicts.find((x) => x.requirementId === reqId);
    if (!v) continue;
    if (v.verdict === 'met') {
      if (!requireEvidence || evidenceAppearsIn(v.evidence, text)) {
        met += 1;
        evidence = evidence ?? v.evidence;
      }
      // si requireEvidence y la cita no aparece → 'met' se ignora (se trata como 'unknown')
    } else if (v.verdict === 'not_met') {
      notMet += 1;
    }
  }
  if (met > notMet) return { verdict: 'met', evidence };
  if (notMet > met) return { verdict: 'not_met', evidence: null };
  return { verdict: 'unknown', evidence: null };
}

function addToBucket(buckets: Map<string, ExclusionBucket>, reason: string, listingId: string) {
  const b = buckets.get(reason) ?? { reason, count: 0, listingIds: [] };
  b.count += 1;
  b.listingIds.push(listingId);
  buckets.set(reason, b);
}

export function rankResults(
  gated: GatedListing[],
  evaluations: Evaluation[],
  requirements: Requirement[],
  opts: RankOptions,
): SearchOutput {
  const textualReqs = requirements.filter((r) => r.kind === 'textual');
  const hardTextual = textualReqs.filter((r) => r.hardness === 'must');
  const niceReqs = requirements.filter((r) => r.hardness === 'nice');
  const niceWeightTotal = niceReqs.reduce((s, r) => s + (r.weight ?? 1), 0);

  const survivors: EvaluatedListing[] = [];
  const buckets = new Map<string, ExclusionBucket>();
  const unevaluable: { listingId: string; error: string }[] = [];

  for (const g of gated) {
    // 1. gate numérico ya resuelto
    if (g.failReason) {
      addToBucket(buckets, g.failReason, g.listing.id);
      continue;
    }
    const evalsForListing = evaluations.filter((e) => e.listingId === g.listing.id);
    // 2. ¿se pudo evaluar? si hay requisitos textuales pero ninguna réplica respondió → inevaluable
    if (textualReqs.length > 0 && evalsForListing.length === 0) {
      unevaluable.push({ listingId: g.listing.id, error: 'sin evaluación textual (agentes fallaron)' });
      continue;
    }

    const text = listingText(g.listing);
    const requirementResults: RequirementVerdict[] = [...g.numericVerdicts];

    // 3. resolver cada requisito textual por mayoría
    for (const r of textualReqs) {
      const m = majorityVerdict(r.id, evalsForListing, text);
      requirementResults.push({ requirementId: r.id, verdict: m.verdict, evidence: m.evidence });
    }

    // 4. gate textual duro: cada must textual debe quedar 'met'
    let excluded = false;
    for (const r of hardTextual) {
      const res = requirementResults.find((x) => x.requirementId === r.id);
      if (res?.verdict !== 'met') {
        addToBucket(buckets, `no confirma "${r.label}"`, g.listing.id);
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    // 5. red flag (marcador, no gate) — sin validación de evidencia (es un juicio, no una cita)
    const rf = majorityVerdict(RED_FLAGS_ID, evalsForListing, text, false);
    const redFlag = rf.verdict === 'met';

    // 6. niceScore = peso de nice cumplidos / peso total nice
    let niceMetWeight = 0;
    for (const r of niceReqs) {
      const res = requirementResults.find((x) => x.requirementId === r.id);
      if (res?.verdict === 'met') niceMetWeight += r.weight ?? 1;
    }
    const niceScore = niceWeightTotal === 0 ? 1 : niceMetWeight / niceWeightTotal;

    survivors.push({
      listing: g.listing,
      passed: true,
      requirementResults,
      niceScore,
      redFlag,
      partialData: g.listing.dataSource === 'card',
    });
  }

  survivors.sort((a, b) => b.niceScore - a.niceScore || a.listing.price.amount - b.listing.price.amount);

  const degraded = hardTextual.length > 0 && survivors.length === 0 && unevaluable.length > 0;
  return { survivors, exclusions: [...buckets.values()], unevaluable, degraded };
}
```

- [ ] **Step 3:** Run `pnpm run test:unit -- __tests__/ranking` → PASS (6 tests). Si el orden de `niceScore` redondea distinto, revisá la fórmula contra el test — NO cambies el test.

- [ ] **Step 4: Eliminar consensus viejo**

```bash
git rm src/server/consensus.ts src/server/__tests__/consensus.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/server/ranking.ts src/server/__tests__/ranking.test.ts
git commit -m "feat: ranking with hard gates, evidence-validated majority, exclusion buckets"
```

---

### Task 9: Adquisición v2 — fetch de detalle por aviso

**Files:**
- Create: `src/server/adapters/argenprop/detail.ts`, `src/server/adapters/argenprop/__fixtures__/detail-page.html` (grabado)
- Modify: `src/server/adapters/argenprop/normalize.ts` (campo `dataSource`), `src/server/adapters/argenprop/index.ts` (enriquecer con detalle)
- Test: `src/server/adapters/argenprop/__tests__/detail.test.ts`

- [ ] **Step 1: Ajustar `normalize.ts`** — agregar `dataSource: 'card'` por default al objeto que devuelve `normalizeListing` (la tarjeta no tiene detalle todavía). Buscar el `return { ... }` de `normalizeListing` y añadir `dataSource: 'card' as const,`. Correr `pnpm run test:unit -- argenprop/__tests__/normalize` y, si el test de `normalizeListing` chequea el objeto completo con `toEqual`, agregar `dataSource: 'card'` al esperado; si usa `toMatchObject`, no hace falta.

- [ ] **Step 2: Grabar el fixture de detalle**

```bash
# Tomá una URL de aviso real del fixture de listado existente:
grep -oE 'https://www\.argenprop\.com/[a-z0-9-]+--[0-9]+' \
  src/server/adapters/argenprop/__fixtures__/list-page.html | head -1
# Descargá esa página de detalle (reemplazá <URL> por la de arriba):
curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  "<URL>" -o src/server/adapters/argenprop/__fixtures__/detail-page.html
wc -c src/server/adapters/argenprop/__fixtures__/detail-page.html
```

Expected: > 50KB de HTML con la descripción larga del aviso. Si devuelve challenge/captcha o < 20KB, guardá la página desde el browser. Si no se puede en absoluto, reportá BLOCKED (no inventes fixture).

- [ ] **Step 3: Test del parser de detalle que falla** — `__tests__/detail.test.ts` (asserts de invariante, no de valores exactos):

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseDetail } from '../detail';

const html = fs.readFileSync(path.join(__dirname, '../__fixtures__/detail-page.html'), 'utf-8');

describe('parseDetail (fixture)', () => {
  it('extracts a long description and an amenities list', () => {
    const d = parseDetail(html);
    expect(d.detailDescription.length).toBeGreaterThan(100);
    expect(Array.isArray(d.amenities)).toBe(true);
  });
  it('returns empty fields for non-detail html without throwing', () => {
    const d = parseDetail('<html><body><h1>nada</h1></body></html>');
    expect(d.detailDescription).toBe('');
    expect(d.amenities).toEqual([]);
  });
});
```

Run: `pnpm run test:unit -- argenprop/__tests__/detail` → FAIL.

- [ ] **Step 4: Implementar `detail.ts` y ajustar selectores contra el fixture**

```ts
import * as cheerio from 'cheerio';

// Selectores de la página de detalle de Argenprop. Si el portal cambia el HTML, ajustar acá
// y re-grabar el fixture (ver __tests__/detail.test.ts).
const SEL = {
  description: '.section-description--content, .property-description, [class*="description"]',
  amenities: '.property-features li, .features li, [class*="amenities"] li',
};

export interface ParsedDetail {
  detailDescription: string;
  amenities: string[];
}

export function parseDetail(html: string): ParsedDetail {
  const $ = cheerio.load(html);
  const detailDescription = $(SEL.description).first().text().replace(/\s+/g, ' ').trim();
  const amenities = $(SEL.amenities)
    .map((_, li) => $(li).text().trim())
    .get()
    .filter(Boolean);
  return { detailDescription, amenities };
}
```

**Iterar:** correr el test; si `detailDescription` queda vacío, inspeccionar el fixture (`grep -oE 'class="[^"]*"' detail-page.html | sort -u | grep -iE 'desc|feature|amenit' | head`) y corregir `SEL` hasta que pase. NO cambiar los asserts.

Run: `pnpm run test:unit -- argenprop/__tests__/detail` → PASS.

- [ ] **Step 5: Enriquecer el adapter `index.ts`** — después de armar el pool desde el listado, abrir el detalle de cada aviso con concurrencia limitada y throttle. Agregar al adapter:

```ts
import { parseDetail } from './detail';

const DETAIL_CONCURRENCY = 5;
const DETAIL_DELAY_MS = 150; // throttle cortés entre fetches

async function enrichWithDetail(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
  const queue = [...listings];
  const out: NormalizedListing[] = [];
  const worker = async () => {
    for (let l = queue.shift(); l !== undefined; l = queue.shift()) {
      try {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        const page = await fetchPage(l.url); // reusar el fetchPage del adapter (UA + timeout)
        if (page.html) {
          const d = parseDetail(page.html);
          out.push({ ...l, detailDescription: d.detailDescription, amenities: d.amenities, dataSource: 'detail' });
          continue;
        }
      } catch {
        // cae a datos de tarjeta
      }
      out.push({ ...l, dataSource: 'card' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker));
  return out;
}
```

Y en `search(criteria)`, después de construir `[...byId.values()]` y antes de devolver, pasar por `enrichWithDetail`. Mantener el manejo de `blocked` existente (el enrich no cambia el status; si el listado fue `ok` sigue `ok`). Asegurate de que `fetchPage` sea accesible (si es función módulo-local, ya lo es).

> Nota: el `index.test.ts` existente mockea `fetch`. Con el enrich, `search()` hará fetches adicionales (uno por listing). Actualizá el mock del test de index si es necesario para que `fetch` del detalle devuelva algo razonable, o que el test de "blocked"/"error" siga valiendo (esos cortan antes del enrich porque el listado da 0 listings). Si el test de `'ok'` ahora dispara fetches de detalle, hacé que el mock resuelva un HTML mínimo para todas las llamadas.

- [ ] **Step 6:** Run `pnpm run test:unit -- argenprop` → todos los tests del adapter PASS (url, normalize, parse, detail, index). Ajustá los mocks de `index.test.ts` si el enrich los rompió (sin debilitar los asserts de comportamiento).

- [ ] **Step 7: Commit**

```bash
git add src/server/adapters/argenprop
git commit -m "feat: fetch listing detail pages (throttled) to enrich the pool"
```

---

### Task 10: Orquestador v2 + DB

**Files:**
- Modify: `src/server/search.ts` (reescritura del pipeline), `src/server/db.ts` (persistir criteria v2, evaluations, output)
- Test: `src/server/__tests__/search.test.ts` (reescribir)

- [ ] **Step 1: Ajustar `db.ts`** — el `votes` table y los métodos `saveVote/getVotes` pasan a `evaluations`. Cambios mínimos:
  - Renombrar conceptualmente: agregar métodos `saveEvaluation(id, evaluation: Evaluation)` (PK `search_id, listing_id, replica`) y `getEvaluations(id): Evaluation[]`. Podés reusar la tabla `votes` renombrándola a `evaluations` en el `SCHEMA` con PK `(search_id, listing_id, replica)`.
  - `saveResults(id, output: SearchOutput)` / `getResults(id): SearchOutput | undefined` — cambiar el tipo de `ConsensusOutput` a `SearchOutput` (import desde `~/types`; ya no existe `consensus.ts`).
  - `saveCriteria` ya guarda el `SearchCriteria` completo como JSON → con requirements funciona sin cambios.
  Actualizá `db.test.ts`: el test que guardaba `Vote` ahora guarda `Evaluation`; el que guardaba `ConsensusOutput` ahora `SearchOutput` (`{ survivors: [], exclusions: [], unevaluable: [], degraded: false }`). Mantené los asserts de round-trip.

  Run: `pnpm run test:unit -- __tests__/db` → PASS.

- [ ] **Step 2: Reescribir el test del orquestador** — `src/server/__tests__/search.test.ts`:

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import { runSearch, type SearchDeps } from '../search';
import { openDb, type SearchDb } from '../db';
import type { AdapterResult } from '../adapters/types';
import { RED_FLAGS_ID, type Evaluation, type NormalizedListing, type SearchCriteria, type SearchEvent, type SearchParams } from '~/types';

const criteria: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo'],
  currency: 'ARS',
  rawDescription: 'depto',
  requirements: [
    { id: 'r1', label: '≥165 m²', hardness: 'must', kind: 'numeric', predicate: { field: 'm2', op: '>=', value: 165 } },
    { id: 'r2', label: 'mascotas', hardness: 'must', kind: 'textual', statement: 's' },
    { id: 'r3', label: 'luminoso', hardness: 'nice', kind: 'textual', statement: 's', weight: 1 },
  ],
};

const big: NormalizedListing = { id: 'big', url: 'https://x/big', portal: 'argenprop', title: 'grande', price: { amount: 100, currency: 'ARS' }, barrio: 'Palermo', m2: 180, features: [], description: 'apto mascotas, luminoso', detailDescription: 'apto mascotas, luminoso', dataSource: 'detail' };
const small: NormalizedListing = { ...big, id: 'small', url: 'https://x/small', m2: 50 };

const params: SearchParams = { description: 'depto', replicas: 1, tokenBudget: 1_000_000 };

function makeDeps(db: SearchDb, events: SearchEvent[], over: Partial<SearchDeps> = {}): SearchDeps {
  return {
    db,
    adapters: [{ name: 'argenprop', tier: 'scraper', search: async (): Promise<AdapterResult> => ({ status: 'ok', listings: [big, small] }) }],
    intake: async () => ({ criteria, tokens: 100 }),
    evaluate: async ({ listing, replica }) => ({
      evaluation: {
        listingId: listing.id,
        replica,
        verdicts: [
          { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
          { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
          { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
        ],
      } as Evaluation,
      tokens: 1000,
    }),
    emit: (e) => events.push(e),
    concurrency: 1,
    ...over,
  };
}

describe('runSearch v2', () => {
  let db: SearchDb;
  let events: SearchEvent[];
  beforeEach(() => {
    db = openDb(':memory:');
    events = [];
  });
  afterEach(() => db.close());

  it('numeric gate excludes the small listing before any LLM eval', async () => {
    db.createSearch('s1', params);
    const evaluate = jest.fn(makeDeps(db, events).evaluate);
    await runSearch('s1', params, makeDeps(db, events, { evaluate }));
    const out = db.getResults('s1')!;
    expect(out.survivors.map((s) => s.listing.id)).toEqual(['big']); // small (50 m²) afuera
    expect(out.exclusions.some((b) => b.listingIds.includes('small'))).toBe(true);
    // el evaluador SOLO corrió sobre 'big' (small murió en el gate numérico, no gastó tokens)
    const evaluatedIds = evaluate.mock.calls.map((c) => (c[0] as { listing: NormalizedListing }).listing.id);
    expect(evaluatedIds).not.toContain('small');
    expect(db.getSearch('s1')?.status).toBe('done');
  });

  it('uses provided criteria and skips intake when params.criteria is set', async () => {
    db.createSearch('s1', params);
    const intake = jest.fn(async () => ({ criteria, tokens: 100 }));
    await runSearch('s1', { ...params, criteria }, makeDeps(db, events, { intake }));
    expect(intake).not.toHaveBeenCalled();
  });

  it('empty pool ends with error', async () => {
    db.createSearch('s1', params);
    await runSearch('s1', params, makeDeps(db, events, {
      adapters: [{ name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'blocked' as const, listings: [] }) }],
    }));
    expect(db.getSearch('s1')?.status).toBe('error');
  });

  it('a failing evaluator on a hard req marks the listing unevaluable, not excluded as non-compliant', async () => {
    db.createSearch('s1', params);
    await runSearch('s1', { ...params }, makeDeps(db, events, {
      // solo 'big' pasa el gate; su evaluador falla
      evaluate: jest.fn<SearchDeps['evaluate']>().mockRejectedValue(new Error('agent died')),
    }));
    const out = db.getResults('s1')!;
    expect(out.survivors).toHaveLength(0);
    expect(out.unevaluable.some((u) => u.listingId === 'big')).toBe(true);
  });

  it('emits the new phases in order', async () => {
    db.createSearch('s1', params);
    await runSearch('s1', params, makeDeps(db, events));
    const phases = events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['intake', 'acquisition', 'numeric_gate', 'textual_eval', 'ranking']);
  });
});
```

Run: `pnpm run test:unit -- __tests__/search` → FAIL.

- [ ] **Step 3: Reescribir `src/server/search.ts`**

```ts
import { applyNumericGates } from './gates';
import { rankResults, type GatedListing } from './ranking';
import type { PortalAdapter } from './adapters/types';
import type { SearchDb } from './db';
import type { runIntake } from './llm/intake';
import type { runEvaluator } from './llm/evaluate';
import {
  type Evaluation,
  type NormalizedListing,
  type SearchCriteria,
  type SearchEvent,
  type SearchParams,
} from '~/types';

export interface SearchDeps {
  db: SearchDb;
  adapters: PortalAdapter[];
  intake: typeof runIntake;
  evaluate: typeof runEvaluator;
  emit: (e: SearchEvent) => void;
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;
const ESTIMATED_EVAL_TOKENS = 40_000; // reserva optimista por evaluación (reconciliada con el real)

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

export async function runSearch(id: string, params: SearchParams, deps: SearchDeps): Promise<void> {
  const { db, emit } = deps;
  let tokensUsed = 0;
  const trackTokens = (n: number) => {
    tokensUsed += n;
    emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
  };

  try {
    // 1. INTAKE (o usar criteria provisto por el usuario)
    db.setStatus(id, 'intake');
    emit({ type: 'phase', phase: 'intake' });
    let criteria: SearchCriteria;
    if (params.criteria) {
      criteria = params.criteria;
    } else {
      const r = await deps.intake(params.description);
      criteria = r.criteria;
      trackTokens(r.tokens);
    }
    db.saveCriteria(id, criteria);
    emit({ type: 'criteria', criteria });

    // 2. ACQUISITION (+ detalle, dentro del adapter)
    db.setStatus(id, 'acquisition');
    emit({ type: 'phase', phase: 'acquisition' });
    const byId = new Map<string, NormalizedListing>();
    for (const adapter of deps.adapters) {
      emit({ type: 'adapter', portal: adapter.name, status: 'running' });
      try {
        const result = await adapter.search(criteria);
        for (const l of result.listings) byId.set(l.id, l);
        emit({ type: 'adapter', portal: adapter.name, status: result.status, count: result.listings.length, detail: result.detail });
      } catch (err) {
        emit({ type: 'adapter', portal: adapter.name, status: 'error', detail: err instanceof Error ? err.message : 'unknown' });
      }
    }
    const pool = [...byId.values()];
    if (pool.length === 0) {
      db.setStatus(id, 'error');
      emit({ type: 'error', message: 'Ningún portal devolvió avisos (¿bloqueo o sin resultados?)' });
      return;
    }
    db.savePool(id, pool);

    // 3. NUMERIC GATE (código, gratis) — achica el pool antes de gastar tokens
    db.setStatus(id, 'numeric_gate');
    emit({ type: 'phase', phase: 'numeric_gate' });
    const gated: GatedListing[] = pool.map((listing) => {
      const g = applyNumericGates(listing, criteria.requirements);
      return { listing, numericVerdicts: g.verdicts, failReason: g.passed ? undefined : g.failReason };
    });
    const survivorsOfGate = gated.filter((g) => !g.failReason);
    emit({ type: 'gate', survived: survivorsOfGate.length, total: pool.length });

    // 4. TEXTUAL EVAL (LLM, réplicas, circuit breaker)
    db.setStatus(id, 'textual_eval');
    emit({ type: 'phase', phase: 'textual_eval' });
    const hasTextual = criteria.requirements.some((r) => r.kind === 'textual');
    if (hasTextual && survivorsOfGate.length > 0) {
      const jobs = survivorsOfGate.flatMap((g) =>
        Array.from({ length: params.replicas }, (_, i) => ({ listing: g.listing, replica: i + 1 })),
      );
      await mapWithConcurrency(jobs, deps.concurrency ?? DEFAULT_CONCURRENCY, async ({ listing, replica }) => {
        if (tokensUsed >= params.tokenBudget) {
          emit({ type: 'eval', listingId: listing.id, replica, status: 'skipped' });
          return;
        }
        tokensUsed += ESTIMATED_EVAL_TOKENS;
        emit({ type: 'eval', listingId: listing.id, replica, status: 'running' });
        try {
          const { evaluation, tokens } = await deps.evaluate({ listing, requirements: criteria.requirements, replica });
          tokensUsed += tokens - ESTIMATED_EVAL_TOKENS;
          emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
          db.saveEvaluation(id, evaluation);
          emit({ type: 'eval', listingId: listing.id, replica, status: 'ok' });
        } catch (err) {
          tokensUsed -= ESTIMATED_EVAL_TOKENS;
          emit({ type: 'eval', listingId: listing.id, replica, status: 'error', detail: err instanceof Error ? err.message : String(err) });
        }
      });
    }

    // 5. RANKING (código puro)
    db.setStatus(id, 'ranking');
    emit({ type: 'phase', phase: 'ranking' });
    const evaluations: Evaluation[] = db.getEvaluations(id);
    const output = rankResults(gated, evaluations, criteria.requirements, { replicas: params.replicas });
    db.saveResults(id, output);
    db.setStatus(id, 'done');
    emit({ type: 'done', resultCount: output.survivors.length, degraded: output.degraded, partial: tokensUsed >= params.tokenBudget });
  } catch (err) {
    db.setStatus(id, 'error');
    emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' });
  }
}
```

- [ ] **Step 4:** Run `pnpm run test:unit -- __tests__/search` → PASS (5 tests).

- [ ] **Step 5:** Run `pnpm run test:unit` (suite completa) → todo verde. Arreglá cualquier import roto que quede (grep `consensus`, `llm/vote`, `llm/lenses`).

- [ ] **Step 6: Commit**

```bash
git add src/server/search.ts src/server/db.ts src/server/__tests__/search.test.ts src/server/__tests__/db.test.ts
git commit -m "feat: orchestrator v2 (intake → acquire → numeric gate → textual eval → ranking)"
```

---

### Task 11: API + UI + smoke e2e

**Files:**
- Create: `src/app/api/intake/route.ts`
- Modify: `src/app/api/search/route.ts`, `src/containers/Search/SearchForm.tsx`, `src/containers/Search/SearchPage.tsx`, `src/containers/Search/ProgressPanel.tsx`, `src/containers/Search/ResultsList.tsx`

- [ ] **Step 1: Crear `src/app/api/intake/route.ts`** (paso de interpretación: descripción → criteria con requisitos, para que el usuario edite antes de buscar):

```ts
import { NextResponse } from 'next/server';
import { runIntake } from '~/server/llm/intake';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { description?: string };
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }
  try {
    const { criteria } = await runIntake(description);
    return NextResponse.json({ criteria });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'intake failed' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Modificar `src/app/api/search/route.ts`** — quitar `threshold`, aceptar `criteria` editado, pasar `runEvaluator` en vez de `runVotingAgent`:

```ts
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { argenpropAdapter } from '~/server/adapters/argenprop';
import { getDb } from '~/server/db';
import { emitSearchEvent } from '~/server/events';
import { runIntake } from '~/server/llm/intake';
import { runEvaluator } from '~/server/llm/evaluate';
import { runSearch } from '~/server/search';
import type { SearchCriteria, SearchParams } from '~/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clampInt(v: unknown, min: number, max: number, fb: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }
  const params: SearchParams = {
    description,
    replicas: clampInt(body.replicas, 1, 4, 1),
    tokenBudget: clampInt(body.tokenBudget, 50_000, 5_000_000, 500_000),
    criteria: (body.criteria as SearchCriteria | undefined) ?? undefined,
  };

  const id = randomUUID();
  const db = getDb();
  db.createSearch(id, params);
  void runSearch(id, params, {
    db,
    adapters: [argenpropAdapter],
    intake: runIntake,
    evaluate: runEvaluator,
    emit: (e) => emitSearchEvent(id, e),
  }).catch((err) => console.error(`search ${id} crashed:`, err));

  return NextResponse.json({ id });
}
```

> `db.createSearch` guarda `params`; si `params.criteria` está, el orquestador lo usa. (El `SearchParams` ahora tiene `criteria?` — Task 1.)

- [ ] **Step 3: Reescribir `SearchForm.tsx`** — flujo de dos pasos: describir → "Interpretar" (llama `/api/intake`) → editar requisitos (must/nice + peso) → "Buscar". Quitar el slider de threshold. Componente completo:

```tsx
'use client';

import { useState } from 'react';
import { Button, Chip, IconButton, MenuItem, Select, Stack, TextField, Tooltip, Typography } from '@mui/material';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import type { Requirement, SearchCriteria, SearchParams } from '~/types';

const DEPTHS = [
  { replicas: 1, label: 'Económico (1× por aviso)' },
  { replicas: 2, label: 'Medio (2×)' },
  { replicas: 4, label: 'Profundo (4×)' },
];
const BUDGETS = [
  { value: 200_000, label: '200k tokens' },
  { value: 500_000, label: '500k tokens' },
  { value: 1_500_000, label: '1.5M tokens' },
];

type Props = {
  disabled: boolean;
  onSubmit: (params: SearchParams) => void;
};

export const SearchForm = ({ disabled, onSubmit }: Props) => {
  const [description, setDescription] = useState('');
  const [replicas, setReplicas] = useState(1);
  const [tokenBudget, setTokenBudget] = useState(500_000);
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interpret = async () => {
    setInterpreting(true);
    setError(null);
    try {
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });
      const data = (await res.json()) as { criteria?: SearchCriteria; error?: string };
      if (!res.ok || !data.criteria) throw new Error(data.error ?? 'No se pudo interpretar');
      setCriteria(data.criteria);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setInterpreting(false);
    }
  };

  const toggleHardness = (id: string) =>
    setCriteria((c) =>
      c
        ? {
            ...c,
            requirements: c.requirements.map((r) =>
              r.id === id ? { ...r, hardness: r.hardness === 'must' ? 'nice' : 'must' } : r,
            ),
          }
        : c,
    );

  return (
    <Stack spacing={2} width='100%' maxWidth='72rem'>
      <TextField
        multiline
        minRows={5}
        label='Describí el inmueble que buscás (cuanto más detalle, mejor)'
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={disabled}
        inputProps={{ 'data-testid': 'description-input' }}
      />

      {!criteria && (
        <Button variant='outlined' disabled={disabled || interpreting || description.trim().length < 30} onClick={interpret}>
          {interpreting ? 'Interpretando…' : 'Interpretar requisitos'}
        </Button>
      )}
      {error && <Typography color='error' variant='body2'>{error}</Typography>}

      {criteria && (
        <Stack spacing={1.5}>
          <Typography variant='subtitle2'>
            Tu búsqueda, interpretada — clickeá un requisito para cambiar must↔nice:
          </Typography>
          <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
            {criteria.requirements.map((r: Requirement) => (
              <Tooltip key={r.id} title={r.hardness === 'must' ? 'Innegociable (filtra)' : 'Deseable (rankea)'}>
                <Chip
                  size='small'
                  color={r.hardness === 'must' ? 'error' : 'default'}
                  variant={r.hardness === 'must' ? 'filled' : 'outlined'}
                  label={`${r.hardness === 'must' ? '⛔' : '⭐'} ${r.label}`}
                  onClick={() => !disabled && toggleHardness(r.id)}
                  icon={<SwapHorizIcon />}
                />
              </Tooltip>
            ))}
          </Stack>
          <Stack direction='row' spacing={2} alignItems='center'>
            <Select value={replicas} onChange={(e) => setReplicas(Number(e.target.value))} disabled={disabled} size='small'>
              {DEPTHS.map((d) => (
                <MenuItem key={d.replicas} value={d.replicas}>{d.label}</MenuItem>
              ))}
            </Select>
            <Select value={tokenBudget} onChange={(e) => setTokenBudget(Number(e.target.value))} disabled={disabled} size='small'>
              {BUDGETS.map((b) => (
                <MenuItem key={b.value} value={b.value}>{b.label}</MenuItem>
              ))}
            </Select>
            <Button
              variant='contained'
              disabled={disabled}
              onClick={() => onSubmit({ description: description.trim(), replicas, tokenBudget, criteria })}
              data-testid='search-button'
            >
              Buscar
            </Button>
            <IconButton size='small' onClick={() => setCriteria(null)} disabled={disabled} title='Volver a interpretar'>
              <SwapHorizIcon />
            </IconButton>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
};
```

- [ ] **Step 4: Actualizar `SearchPage.tsx`** — el `SearchParams` ahora trae `criteria`; el POST a `/api/search` lo manda. Cambiar el tipo de `results` para reflejar `SearchOutput`. El handler de `done` fetchea `/api/search/[id]` y guarda `survivors/exclusions/unevaluable/degraded`. Reemplazar el `ResultsState`:

```tsx
import type { SearchOutput } from '~/types';
// ...
const [results, setResults] = useState<SearchOutput | null>(null);
// en el onmessage 'done':
const data = (await (await fetch(`/api/search/${id}`)).json()) as { results: SearchOutput | null };
setResults(data.results ?? null);
// render:
{results && <ResultsList output={results} />}
```

El POST a `/api/search` ahora manda `{ description, replicas, tokenBudget, criteria }` (sin `threshold`).

- [ ] **Step 5: Reescribir `ResultsList.tsx`** — checklist con evidencia + desglose de exclusiones:

```tsx
'use client';

import { Accordion, AccordionDetails, AccordionSummary, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { EvaluatedListing, SearchCriteria, SearchOutput } from '~/types';

type Props = { output: SearchOutput; criteria?: SearchCriteria };

export const ResultsList = ({ output, criteria }: Props) => {
  const label = (id: string) => criteria?.requirements.find((r) => r.id === id)?.label ?? id;
  const isMust = (id: string) => criteria?.requirements.find((r) => r.id === id)?.hardness === 'must';

  return (
    <Stack spacing={1.5} width='100%' maxWidth='72rem' data-testid='results'>
      <Typography variant='h6'>
        {output.survivors.length} avisos cumplen tus requisitos{output.degraded ? ' — ⚠ degradado' : ''}
      </Typography>

      {(output.exclusions.length > 0 || output.unevaluable.length > 0) && (
        <Typography variant='caption' color='text.secondary'>
          Excluidos: {output.exclusions.map((b) => `${b.count} (${b.reason})`).join(' · ')}
          {output.unevaluable.length > 0 ? ` · ⚠ ${output.unevaluable.length} no se pudieron evaluar` : ''}
        </Typography>
      )}

      {output.survivors.map((r: EvaluatedListing) => (
        <Paper key={r.listing.id} variant='outlined' sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Stack direction='row' spacing={1} alignItems='center'>
              <Chip size='small' color='success' label={`${Math.round(r.niceScore * 100)}% deseables`} />
              {r.redFlag && <Chip size='small' color='warning' label='⚠ red flag' />}
              {r.partialData && <Chip size='small' variant='outlined' label='datos parciales' />}
              <Link href={r.listing.url} target='_blank' rel='noopener noreferrer'>{r.listing.title}</Link>
            </Stack>
            <Typography variant='body2'>
              {r.listing.price.currency} {r.listing.price.amount.toLocaleString()} · {r.listing.barrio}
              {r.listing.ambientes ? ` · ${r.listing.ambientes} amb` : ''}
              {r.listing.m2 ? ` · ${r.listing.m2} m²` : ''}
            </Typography>
            <Accordion disableGutters variant='outlined'>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant='caption'>Requisitos verificados (con evidencia)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={0.5}>
                  {r.requirementResults.map((v) => (
                    <Typography key={v.requirementId} variant='caption'>
                      {v.verdict === 'met' ? '✅' : v.verdict === 'not_met' ? '❌' : '❓'}{' '}
                      <b>{isMust(v.requirementId) ? '⛔' : '⭐'} {label(v.requirementId)}</b>
                      {v.evidence ? ` → "${v.evidence}"` : ' → sin mención'}
                    </Typography>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};
```

(Pasá `criteria` a `ResultsList` desde `SearchPage` — guardalo del evento `criteria` que llega por SSE, o del `GET /api/search/[id]` que devuelve `search.criteria`.)

- [ ] **Step 6: Actualizar `ProgressPanel.tsx`** — las fases nuevas y los eventos `detail`/`gate`/`eval`. Cambiar el array `PHASES`:

```tsx
const PHASES: { key: SearchPhase; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'acquisition', label: 'Adquisición' },
  { key: 'numeric_gate', label: 'Gate numérico' },
  { key: 'textual_eval', label: 'Evaluación' },
  { key: 'ranking', label: 'Ranking' },
];
```

Y manejar los eventos nuevos: `gate` (mostrar "N/M pasaron el gate"), `eval` (chips por `listingId#replica` con su status/detail en tooltip, igual que los agentes antes), `detail` (opcional: "detalle N/M"). Reusá la lógica de colores existente (`AGENT_COLOR` aplica a `eval.status`). Quitá referencias a `agent`/`adapter` viejas que ya no apliquen (el evento `adapter` se mantiene; `agent` se reemplaza por `eval`).

- [ ] **Step 7:** Run `pnpm run lint && pnpm run build` (timeout 600000ms) → ambos PASS. Arreglá tipos de UI sin `as any`.

- [ ] **Step 8: Smoke e2e real (consume cuota ~150-300k)** — `pnpm run dev`, abrir http://localhost:3000 con el browser MCP:
  1. Descripción: *"Departamento en alquiler en Palermo, MÍNIMO 165 m², 3 dormitorios, que acepte mascotas, hasta 1500 dólares, ojalá luminoso y con cochera."*
  2. Click "Interpretar requisitos" → verificar que aparecen los chips (⛔ ≥165 m², ⛔ 3 dormitorios, ⛔ mascotas, ⭐ luminoso, ⭐ cochera) y que el de m² es ⛔ must.
  3. Click "Buscar". Verificar el panel: gate numérico muestra "N/M pasaron", evaluación corre solo sobre los sobrevivientes.
  4. **La verificación clave del rediseño**: que NINGÚN resultado tenga m² < 165 (el bug original). Cada resultado muestra el checklist con ✅ y la cita de evidencia en los must textuales.
  5. Si el gate deja la lista vacía, verificar que el desglose de exclusiones explica por qué ("N por m² < 165", "N por m² no informado").
  Parar el dev server. Reportar: ¿se respetó el ≥165? ¿hay evidencia en los must? ¿el desglose es claro?

- [ ] **Step 9: Commit**

```bash
git add src/app/api src/containers/Search
git commit -m "feat: two-step intake UI, requirement checklist results, new progress phases"
```

---

### Task 12: Verificación final + review global

- [ ] **Step 1:** `pnpm run lint && pnpm run prettier && pnpm run test:unit && pnpm run build` → todo verde (si prettier marca, `prettier:fix` y recommit).
- [ ] **Step 2:** Restos: `grep -rn "consensus\|llm/vote\|llm/lenses\|threshold\|holistico" src/` → no debe quedar nada funcional (comentarios históricos OK).
- [ ] **Step 3: Commit** si quedó algo: `git commit -am "chore: plan 2 final cleanup"`.

---

## Notas para el ejecutor

- **No setear `ANTHROPIC_API_KEY`** — auth vía suscripción Claude Code (igual que el MVP).
- **Tipos del SDK / patrón de import**: `evaluate.ts` e `intake.ts` usan `getQuery` de `sdk.ts` (Task 2). No volver a `createRequire` ni importar `@anthropic-ai/sdk/helpers/zod`.
- **El repo queda roto entre Task 1 y Task 10** (los tipos cambian antes que sus consumidores). Es intencional; cada task arregla su parte. Las tasks de lógica pura (5,6,8) se testean aisladas con `pnpm run test:unit -- <archivo>`.
- **Fixtures de Argenprop** (listado y detalle): el contrato es el test; si el sitio cambió el HTML, ajustar selectores y re-grabar, nunca debilitar asserts.
- **Costo**: solo Task 11 (e2e) y Task 4 (opcional) tocan cuota real.
