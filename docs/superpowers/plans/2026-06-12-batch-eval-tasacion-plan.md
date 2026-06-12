# Batch eval + Tasación CABA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (1) Reducir ~10× el costo de tokens de la búsqueda evaluando avisos en chunks de 12 por llamada al Agent SDK; (2) nueva feature de tasación de departamentos CABA: extracción LLM (1 llamada Sonnet) + motor de cálculo puro (método comparativo TTN + Ross-Heidecke) + datos verificados versionados + tabs UI `Buscar | Tasar`.

**Architecture:** Parte 1 cambia la firma de `runEvaluator` a chunk (`listings: NormalizedListing[]`) y el orquestador particiona los sobrevivientes del gate en chunks×réplicas. Parte 2 agrega `src/server/tasacion/` (constants + data + barrios + engine), `src/server/llm/tasacion-extract.ts`, `POST /api/tasacion` y `src/containers/Tasacion/`. Spec: `docs/superpowers/specs/2026-06-12-batch-eval-tasacion-design.md`.

**Tech Stack:** Next.js 15, TypeScript, MUI, @anthropic-ai/claude-agent-sdk (patrón existente: `getQuery` de `llm/sdk.ts`, json_schema, dynamic import), Jest. Branch: `feat/batch-eval-tasacion`.

**Costo de verificación:** solo Task 10 (smokes) consume cuota real. Todo lo demás corre con mocks.

**Nota JSON imports:** los data files se importan como JSON. Verificar que `tsconfig.json` tenga `"resolveJsonModule": true` en compilerOptions (Next lo trae por default); si no está, agregarlo en Task 5.

---

## Parte 1 — Evaluación por lotes

### Task 1: `runEvaluator` por chunks

**Files:**
- Modify: `src/server/llm/evaluate.ts` (firma batch)
- Test: `src/server/llm/__tests__/evaluate.test.ts` (reescribir)

- [ ] **Step 1: Reescribir el test** — `src/server/llm/__tests__/evaluate.test.ts`:

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { buildEvaluatePrompt, runEvaluator, EVALUATE_MODEL } from '../evaluate';

import type { NormalizedListing, Requirement } from '~/types';

import { RED_FLAGS_ID } from '~/types';

const l1: NormalizedListing = {
  id: 'l1',
  url: 'https://x/1',
  portal: 'argenprop',
  title: 'Depto A',
  price: { amount: 800_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'Luminoso, apto mascotas',
  detailDescription: 'Hermoso departamento luminoso, apto mascotas.',
  dataSource: 'detail',
};
const l2: NormalizedListing = { ...l1, id: 'l2', url: 'https://x/2', title: 'Depto B' };

const textualReqs: Requirement[] = [
  { id: 'r2', label: 'mascotas', hardness: 'must', kind: 'textual', statement: 'acepta mascotas' },
];

const verdictsFor = () => [
  { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
  { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
];

function resultMessage(results: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return { type: 'result', subtype: 'success', structured_output: { results }, usage };
}
function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('buildEvaluatePrompt (batch)', () => {
  it('includes every listing with its id, the requirements, and the red-flags instruction', () => {
    const p = buildEvaluatePrompt([l1, l2], textualReqs);
    expect(p).toContain('listingId="l1"');
    expect(p).toContain('listingId="l2"');
    expect(p).toContain('Depto B');
    expect(p).toContain('r2');
    expect(p).toContain(RED_FLAGS_ID);
  });
});

describe('runEvaluator (batch)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns one Evaluation per listing in the chunk', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        resultMessage([
          { listingId: 'l1', verdicts: verdictsFor() },
          { listingId: 'l2', verdicts: verdictsFor() },
        ]),
      ]),
    );
    const { evaluations, tokens } = await runEvaluator({ listings: [l1, l2], requirements: textualReqs, replica: 2 });
    expect(evaluations).toHaveLength(2);
    expect(evaluations[0]).toMatchObject({ listingId: 'l1', replica: 2 });
    expect(evaluations[1]).toMatchObject({ listingId: 'l2', replica: 2 });
    expect(tokens).toBe(120);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe(EVALUATE_MODEL);
    expect(opts.maxTurns).toBe(6);
  });

  it('drops results whose listingId is not in the chunk and tolerates missing listings', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        resultMessage([
          { listingId: 'l1', verdicts: verdictsFor() },
          { listingId: 'intruso', verdicts: verdictsFor() }, // id ajeno → se descarta
          // l2 ausente → simplemente no hay Evaluation para l2
        ]),
      ]),
    );
    const { evaluations } = await runEvaluator({ listings: [l1, l2], requirements: textualReqs, replica: 1 });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].listingId).toBe('l1');
  });

  it('throws on non-success subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_max_turns', usage: {} }]));
    await expect(runEvaluator({ listings: [l1], requirements: textualReqs, replica: 1 })).rejects.toThrow(
      /error_max_turns/,
    );
  });

  it('throws when structured_output.results is not an array', async () => {
    mockQuery.mockReturnValue(asyncGen([resultMessage(null)]));
    await expect(runEvaluator({ listings: [l1], requirements: textualReqs, replica: 1 })).rejects.toThrow(
      /not an array/,
    );
  });
});
```

- [ ] **Step 2:** Run `pnpm run test:unit -- llm/__tests__/evaluate` → FAIL (firma vieja).

- [ ] **Step 3: Reescribir `src/server/llm/evaluate.ts`** (cambios: schema batch, prompt multi-aviso, firma `listings[]`, maxTurns 6, timeout 180s, filtrado de ids):

```ts
import {
  RED_FLAGS_ID,
  type Evaluation,
  type NormalizedListing,
  type Requirement,
  type RequirementVerdict,
} from '~/types';
import { getQuery, stableStringify, tokensFromUsage, type Usage } from './sdk';

export const EVALUATE_MODEL = 'claude-haiku-4-5';
const AGENT_TIMEOUT_MS = 180_000; // chunk de hasta 12 avisos tarda más que 1
const EVALUATE_MAX_TURNS = 6; // structured output grande (N avisos × M requisitos) necesita varios turnos

const VERDICT_ITEM = {
  type: 'object',
  properties: {
    requirementId: { type: 'string' },
    verdict: { type: 'string', enum: ['met', 'not_met', 'unknown'] },
    evidence: { type: ['string', 'null'] },
  },
  required: ['requirementId', 'verdict', 'evidence'],
  additionalProperties: false,
} as const;

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          listingId: { type: 'string' },
          verdicts: { type: 'array', items: VERDICT_ITEM },
        },
        required: ['listingId', 'verdicts'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

function listingText(listing: NormalizedListing): string {
  return [listing.title, listing.detailDescription ?? listing.description, (listing.amenities ?? []).join(', ')]
    .filter(Boolean)
    .join('\n');
}

/**
 * Prompt por LOTE: el prefijo (instrucciones + requisitos) es estable; los avisos van al final.
 * Amortiza el overhead fijo del Agent SDK (~25-30k tokens/llamada) entre todos los avisos del chunk.
 */
export function buildEvaluatePrompt(listings: NormalizedListing[], requirements: Requirement[]): string {
  const reqList = requirements.filter((r) => r.kind === 'textual').map((r) => ({ id: r.id, statement: r.statement }));
  const avisos = listings.map((l) => `### AVISO listingId="${l.id}"\n${listingText(l)}`).join('\n\n');
  return [
    'Sos un verificador estricto de avisos inmobiliarios de Buenos Aires. Vas a recibir VARIOS avisos. Para CADA aviso y CADA requisito, decidí si ESE aviso lo cumple, CITANDO el fragmento textual de ESE aviso que lo confirma.',
    'Reglas:',
    '- verdict "met" SOLO si el texto del aviso lo confirma, y "evidence" DEBE ser la cita textual exacta del aviso (copiada, no parafraseada).',
    '- verdict "not_met" si el aviso lo contradice. verdict "unknown" si el aviso no dice nada al respecto (NO inventes).',
    '- Si no podés citar evidencia textual, NO uses "met".',
    `- Por cada aviso, evaluá ADEMÁS el requisito especial "${RED_FLAGS_ID}": "met" si detectás RED FLAGS (precio sospechosamente bajo, descripción vaga/genérica, datos contradictorios), "not_met" si parece confiable, "unknown" si no hay info.`,
    '',
    `REQUISITOS (JSON):\n${stableStringify(reqList)}`,
    '',
    `AVISOS (${listings.length}):\n${avisos}`,
    '',
    `Devolvé en "results" una entrada por CADA aviso (usando exactamente su listingId), cada una con un verdict por requisito MÁS uno para "${RED_FLAGS_ID}".`,
  ].join('\n');
}

export interface EvaluatorArgs {
  listings: NormalizedListing[]; // chunk (1..CHUNK_SIZE avisos)
  requirements: Requirement[];
  replica: number;
  model?: string;
  timeoutMs?: number;
}

export async function runEvaluator(args: EvaluatorArgs): Promise<{ evaluations: Evaluation[]; tokens: number }> {
  const { listings, requirements, replica, model = EVALUATE_MODEL, timeoutMs = AGENT_TIMEOUT_MS } = args;
  const query = await getQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const tag = `evaluator chunk[${listings.length}]#${replica}`;
  try {
    for await (const message of query({
      prompt: buildEvaluatePrompt(listings, requirements),
      options: {
        model,
        maxTurns: EVALUATE_MAX_TURNS,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: BATCH_SCHEMA as Record<string, unknown> },
      },
    })) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || !message.structured_output) {
          throw new Error(`${tag} failed: ${message.subtype}`);
        }
        const { results } = message.structured_output as {
          results: { listingId: string; verdicts: RequirementVerdict[] }[];
        };
        if (!Array.isArray(results)) {
          throw new Error(`${tag}: invalid structured_output — results is not an array`);
        }
        const chunkIds = new Set(listings.map((l) => l.id));
        const evaluations: Evaluation[] = results
          .filter((r) => chunkIds.has(r.listingId) && Array.isArray(r.verdicts))
          .map((r) => ({ listingId: r.listingId, replica, verdicts: r.verdicts }));
        return { evaluations, tokens: tokensFromUsage(message.usage as Usage) };
      }
    }
    throw new Error(`${tag}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4:** Run `pnpm run test:unit -- llm/__tests__/evaluate` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/evaluate.ts src/server/llm/__tests__/evaluate.test.ts
git commit -m "feat: batch evaluator (chunk of listings per agent call)"
```

> Nota: `search.ts` queda roto hasta la Task 2 (firma cambiada). Es esperado; Jest compila por archivo.

---

### Task 2: Orquestador con chunks

**Files:**
- Modify: `src/server/search.ts` (jobs por chunk)
- Test: `src/server/__tests__/search.test.ts` (actualizar mocks + test de partición)

- [ ] **Step 1: Actualizar el test** — en `src/server/__tests__/search.test.ts`:

(a) El mock `evaluate` de `makeDeps` cambia a firma batch (devuelve una Evaluation por listing del chunk):

```ts
    evaluate: async ({ listings, replica }) => ({
      evaluations: listings.map((listing) => ({
        listingId: listing.id,
        replica,
        verdicts: [
          { requirementId: 'r2', verdict: 'met' as const, evidence: 'apto mascotas' },
          { requirementId: 'r3', verdict: 'met' as const, evidence: 'luminoso' },
          { requirementId: RED_FLAGS_ID, verdict: 'not_met' as const, evidence: null },
        ],
      })),
      tokens: 1000,
    }),
```

(b) En el test `'numeric gate excludes the small listing before any LLM eval'`, el assert de ids evaluados cambia a inspeccionar los chunks:

```ts
    const evaluatedIds = evaluate.mock.calls.flatMap((c) => (c[0] as { listings: NormalizedListing[] }).listings.map((l) => l.id));
    expect(evaluatedIds).not.toContain('small');
```

(c) El test del evaluador que falla (`'a failing evaluator on a hard req marks the listing unevaluable...'`) no cambia semánticamente (el mock rechaza, el chunk entero falla, `big` queda inevaluable).

(d) Agregar test de partición (usa el nuevo `chunkSize` de SearchDeps):

```ts
  it('partitions gate survivors into chunks of chunkSize × replicas', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...big, id: `b${i}`, url: `https://x/b${i}` }));
    db.createSearch('s1', { ...params, replicas: 2 });
    const evaluate = jest.fn(makeDeps(db, events).evaluate);
    await runSearch(
      's1',
      { ...params, replicas: 2 },
      makeDeps(db, events, {
        adapters: [{ name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'ok' as const, listings: many }) }],
        evaluate,
        chunkSize: 2,
      }),
    );
    // 5 sobrevivientes / chunkSize 2 = 3 chunks; × 2 réplicas = 6 llamadas
    expect(evaluate).toHaveBeenCalledTimes(6);
    const sizes = evaluate.mock.calls.map((c) => (c[0] as { listings: unknown[] }).listings.length).sort();
    expect(sizes).toEqual([1, 1, 2, 2, 2, 2]);
    expect(db.getEvaluations('s1')).toHaveLength(10); // 5 listings × 2 réplicas
  });
```

- [ ] **Step 2:** Run `pnpm run test:unit -- __tests__/search` → FAIL.

- [ ] **Step 3: Modificar `src/server/search.ts`**:

(a) `SearchDeps` gana `chunkSize?: number`; constantes:

```ts
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CHUNK_SIZE = 12;
const ESTIMATED_EVAL_TOKENS = 50_000; // reserva optimista POR CHUNK (reconciliada con el costo real)

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

(b) El bloque de `textual_eval` se reescribe (jobs por chunk; eventos por aviso se mantienen):

```ts
    db.setStatus(id, 'textual_eval');
    emit({ type: 'phase', phase: 'textual_eval' });
    const hasTextual = criteria.requirements.some((r) => r.kind === 'textual');
    if (hasTextual && survivorsOfGate.length > 0) {
      const chunks = chunk(
        survivorsOfGate.map((g) => g.listing),
        deps.chunkSize ?? DEFAULT_CHUNK_SIZE,
      );
      const jobs = chunks.flatMap((listings) =>
        Array.from({ length: params.replicas }, (_, i) => ({ listings, replica: i + 1 })),
      );
      await mapWithConcurrency(jobs, deps.concurrency ?? DEFAULT_CONCURRENCY, async ({ listings, replica }) => {
        if (tokensUsed >= params.tokenBudget) {
          for (const l of listings) emit({ type: 'eval', listingId: l.id, replica, status: 'skipped' });
          return;
        }
        tokensUsed += ESTIMATED_EVAL_TOKENS;
        for (const l of listings) emit({ type: 'eval', listingId: l.id, replica, status: 'running' });
        try {
          const { evaluations, tokens } = await deps.evaluate({ listings, requirements: criteria.requirements, replica });
          tokensUsed += tokens - ESTIMATED_EVAL_TOKENS;
          emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
          const returnedIds = new Set(evaluations.map((e) => e.listingId));
          for (const evaluation of evaluations) db.saveEvaluation(id, evaluation);
          for (const l of listings) {
            if (returnedIds.has(l.id)) {
              emit({ type: 'eval', listingId: l.id, replica, status: 'ok' });
            } else {
              emit({ type: 'eval', listingId: l.id, replica, status: 'error', detail: 'sin veredictos en la respuesta del chunk' });
            }
          }
        } catch (err) {
          tokensUsed -= ESTIMATED_EVAL_TOKENS;
          const detail = err instanceof Error ? err.message : String(err);
          for (const l of listings) emit({ type: 'eval', listingId: l.id, replica, status: 'error', detail });
        }
      });
    }
```

(El resto del pipeline — intake, acquisition, numeric_gate, ranking — no cambia.)

- [ ] **Step 4:** Run `pnpm run test:unit -- __tests__/search` → PASS (6 tests). Luego `pnpm run test:unit` completo → sin regresiones.

- [ ] **Step 5: Commit**

```bash
git add src/server/search.ts src/server/__tests__/search.test.ts
git commit -m "feat: chunked evaluation jobs (~10x fewer agent calls)"
```

---

## Parte 2 — Tasación

### Task 3: Tipos de tasación

**Files:**
- Create: `src/types/tasacion.ts`
- Modify: `src/types/index.ts` (agregar `export * from './tasacion';`)

- [ ] **Step 1: Crear `src/types/tasacion.ts`**:

```ts
export type UbicacionPlanta = 'frente' | 'lateral' | 'contrafrente' | 'interno';
export type CategoriaConstructiva = 'economica' | 'estandar' | 'buena' | 'buena_servicios' | 'premium';

/** Atributos extraídos de la descripción por el LLM. Campo ausente en el texto = null (no se inventa). */
export interface TasacionInput {
  tipoPropiedad: 'departamento' | 'casa' | 'ph';
  barrio: string | null;
  m2Cubiertos: number | null;
  m2Semicubiertos: number | null;
  m2Balcon: number | null;
  m2Descubiertos: number | null;
  piso: number | null; // 0 = planta baja
  tieneAscensor: boolean | null;
  ubicacionPlanta: UbicacionPlanta | null;
  antiguedadAnios: number | null;
  /** Escala Heidecke: 1.0 excelente · 2.0 bueno · 2.5 normal · 3.0 regular · 3.5 malo · 4.0 muy malo */
  estadoConservacion: number | null;
  tieneCochera: boolean;
  tieneBaulera: boolean;
  amenities: string[];
  categoriaConstructiva: CategoriaConstructiva | null;
  aEstrenar: boolean;
}

export interface BreakdownItem {
  concepto: string; // "Superficie homogeneizada", "Coef. piso (5°, c/ascensor)", ...
  valor: string; // "77.6 m²", "×1.04", "USD 3.403/m²", ...
  efecto?: string; // opcional: efecto acumulado en USD
}

export interface TasacionResult {
  valorEstimadoUsd: number; // redondeado a centenas
  rangoUsd: [number, number]; // ±15%
  confianza: 'alta' | 'media' | 'baja';
  superficieHomogeneizada: number;
  breakdown: BreakdownItem[];
  supuestos: string[]; // supuestos/defaults aplicados, en lenguaje humano
  fuentePrecios: { fuente: string; fecha: string; barrioUsado: string; fallback: boolean };
}
```

- [ ] **Step 2:** Agregar `export * from './tasacion';` a `src/types/index.ts`. Run `pnpm run lint` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/types/tasacion.ts src/types/index.ts
git commit -m "feat: tasacion domain types"
```

---

### Task 4: Constantes y helpers de cálculo (TDD)

**Files:**
- Create: `src/server/tasacion/constants.ts`
- Test: `src/server/tasacion/__tests__/constants.test.ts`

- [ ] **Step 1: Test que falla** — `src/server/tasacion/__tests__/constants.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { coefAmenities, coefPiso, interpolate, rossHeideckeK, ESCALA_TABLE } from '../constants';

describe('coefPiso', () => {
  it('con ascensor: PB 0.90, 1° 0.95, 3° base 1.0, sube 0.02/piso con tope 1.15', () => {
    expect(coefPiso(0, true)).toBeCloseTo(0.9);
    expect(coefPiso(1, true)).toBeCloseTo(0.95);
    expect(coefPiso(3, true)).toBeCloseTo(1.0);
    expect(coefPiso(5, true)).toBeCloseTo(1.04);
    expect(coefPiso(20, true)).toBeCloseTo(1.15); // tope
  });
  it('sin ascensor: PB 1.0 y baja 0.05 por piso (piso 0.70 mínimo)', () => {
    expect(coefPiso(0, false)).toBeCloseTo(1.0);
    expect(coefPiso(2, false)).toBeCloseTo(0.9);
    expect(coefPiso(10, false)).toBeCloseTo(0.7); // piso del coeficiente
  });
  it('piso null → neutro 1.0; ascensor null → se asume con ascensor', () => {
    expect(coefPiso(null, true)).toBeCloseTo(1.0);
    expect(coefPiso(5, null)).toBeCloseTo(1.04);
  });
});

describe('interpolate', () => {
  it('interpola linealmente y clampea en los extremos', () => {
    expect(interpolate(ESCALA_TABLE, 85)).toBeCloseTo(1.0);
    expect(interpolate(ESCALA_TABLE, 25)).toBeCloseTo(1.35);
    expect(interpolate(ESCALA_TABLE, 20)).toBeCloseTo(1.35); // clamp inferior
    expect(interpolate(ESCALA_TABLE, 500)).toBeCloseTo(0.9); // clamp superior
    const mid = interpolate(ESCALA_TABLE, 67.5); // entre 60 (1.08) y 75 (1.02)
    expect(mid).toBeGreaterThan(1.02);
    expect(mid).toBeLessThan(1.08);
  });
});

describe('rossHeideckeK', () => {
  it('estado excelente nuevo no deprecia; 100% de vida deprecia total', () => {
    expect(rossHeideckeK(0, 1.0)).toBeCloseTo(0);
    expect(rossHeideckeK(100, 2.5)).toBeCloseTo(1.0);
  });
  it('valores de tabla exactos (50% vida, estado bueno 2.0 → 0.293)', () => {
    expect(rossHeideckeK(50, 2.0)).toBeCloseTo(0.293);
  });
  it('interpola entre filas y entre estados; clampea estado a [1.0, 3.5]', () => {
    const k = rossHeideckeK(25, 2.25); // entre filas 20/30 y estados 2.0/2.5
    expect(k).toBeGreaterThan(rossHeideckeK(25, 2.0));
    expect(k).toBeLessThan(rossHeideckeK(25, 2.5));
    expect(rossHeideckeK(50, 4.5)).toBeCloseTo(rossHeideckeK(50, 3.5)); // clamp
  });
});

describe('coefAmenities', () => {
  it('0 → 1.0, 1-2 → 1.05, 3+ → 1.10', () => {
    expect(coefAmenities(0)).toBe(1.0);
    expect(coefAmenities(2)).toBe(1.05);
    expect(coefAmenities(4)).toBe(1.1);
  });
});
```

- [ ] **Step 2:** Run `pnpm run test:unit -- tasacion/__tests__/constants` → FAIL.

- [ ] **Step 3: Implementar `src/server/tasacion/constants.ts`**:

```ts
import type { CategoriaConstructiva, UbicacionPlanta } from '~/types';

// ═══ Coeficientes estables de la práctica de tasación argentina ═══
// Fuentes: Norma TTN 3.1 (método comparativo), TTN 4.1 (método del costo / Ross-Heidecke),
// tablas de práctica profesional (El Tasador Pampeano). Ver spec 2026-06-12.

/** Homogeneización de superficies (m² ponderado). */
export const COEF_SUPERFICIE = {
  cubierta: 1.0,
  semicubierta: 0.5,
  balcon: 0.33,
  descubierta: 0.2,
  baulera: 0.35,
} as const;

/** m² asumidos para una baulera cuando el aviso no da metraje. */
export const BAULERA_M2_DEFAULT = 4;

/** Coeficiente por piso. Base = 3° piso con ascensor (1.0). */
export function coefPiso(piso: number | null, tieneAscensor: boolean | null): number {
  if (piso === null) return 1.0;
  const p = Math.max(0, Math.min(30, Math.round(piso)));
  if (tieneAscensor === false) {
    // sin ascensor: PB vale base y cada piso resta 5%, con piso en 0.70
    return Math.max(0.7, 1.0 - 0.05 * p);
  }
  // con ascensor (null se asume ascensor: edificios CABA)
  if (p === 0) return 0.9;
  if (p === 1) return 0.95;
  if (p === 2) return 0.98;
  return Math.min(1.15, 1.0 + 0.02 * (p - 3));
}

export const COEF_UBICACION: Record<UbicacionPlanta, number> = {
  frente: 1.0,
  lateral: 0.94,
  contrafrente: 0.85,
  interno: 0.8,
};

export const COEF_CALIDAD: Record<CategoriaConstructiva, number> = {
  economica: 0.9,
  estandar: 1.0,
  buena: 1.1,
  buena_servicios: 1.2,
  premium: 1.35,
};

/** Coeficiente de escala: deptos chicos valen más por m². [supHom, coef] — interpolación lineal. */
export const ESCALA_TABLE: [number, number][] = [
  [25, 1.35],
  [40, 1.25],
  [50, 1.15],
  [60, 1.08],
  [75, 1.02],
  [85, 1.0],
  [110, 0.96],
  [150, 0.9],
];

export function coefAmenities(cantidad: number): number {
  if (cantidad === 0) return 1.0;
  return cantidad <= 2 ? 1.05 : 1.1;
}

/** Interpolación lineal sobre una tabla [x, y] ordenada por x; clampea en los extremos. */
export function interpolate(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i - 1];
    const [x2, y2] = table[i];
    if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

// ═══ Ross-Heidecke (Norma TTN 4.1) ═══
export const VIDA_UTIL_ANIOS = 100; // hormigón armado, edificios de altura CABA
/** Proporción del valor total que representa la construcción (el suelo no deprecia). [SUPUESTO documentado] */
export const FACTOR_EDIFICIO = 0.45;
/** Premio "a estrenar" sobre el promedio de mercado usado. [SUPUESTO documentado] */
export const COEF_ESTRENAR = 1.1;

/** Estados Heidecke de las columnas de la tabla K. */
const RH_ESTADOS = [1.0, 2.0, 2.5, 3.0, 3.5];
/** Filas: % de vida transcurrida 0..100 (paso 10). Valores representativos de la tabla TTN 4.1. */
const RH_TABLE: number[][] = [
  [0.0, 0.0, 0.0, 0.0, 0.0],
  [0.032, 0.067, 0.1, 0.132, 0.171],
  [0.052, 0.114, 0.154, 0.21, 0.289],
  [0.083, 0.163, 0.22, 0.316, 0.43],
  [0.117, 0.221, 0.306, 0.44, 0.572],
  [0.16, 0.293, 0.408, 0.559, 0.693],
  [0.215, 0.382, 0.516, 0.667, 0.792],
  [0.293, 0.49, 0.638, 0.773, 0.872],
  [0.39, 0.617, 0.752, 0.858, 0.932],
  [0.519, 0.763, 0.869, 0.93, 0.967],
  [1.0, 1.0, 1.0, 1.0, 1.0],
];

/** K de depreciación Ross-Heidecke con interpolación bilineal (filas %vida, columnas estado). */
export function rossHeideckeK(pctVida: number, estado: number): number {
  const pct = Math.max(0, Math.min(100, pctVida));
  const est = Math.max(RH_ESTADOS[0], Math.min(RH_ESTADOS[RH_ESTADOS.length - 1], estado));

  const row = pct / 10;
  const r0 = Math.floor(row);
  const r1 = Math.min(10, r0 + 1);
  const rt = row - r0;

  let c1 = RH_ESTADOS.length - 1;
  for (let i = 1; i < RH_ESTADOS.length; i++) {
    if (est <= RH_ESTADOS[i]) {
      c1 = i;
      break;
    }
  }
  const c0 = c1 - 1 < 0 ? 0 : c1 - 1;
  const span = RH_ESTADOS[c1] - RH_ESTADOS[c0];
  const ct = span === 0 ? 0 : (est - RH_ESTADOS[c0]) / span;

  const kr0 = RH_TABLE[r0][c0] + (RH_TABLE[r0][c1] - RH_TABLE[r0][c0]) * ct;
  const kr1 = RH_TABLE[r1][c0] + (RH_TABLE[r1][c1] - RH_TABLE[r1][c0]) * ct;
  return kr0 + (kr1 - kr0) * rt;
}
```

- [ ] **Step 4:** Run `pnpm run test:unit -- tasacion/__tests__/constants` → PASS. (Si `rossHeideckeK(50, 2.0)` no da 0.293 exacto, revisá la indexación de columnas — el test fija el contrato, no lo cambies.)

- [ ] **Step 5: Commit**

```bash
git add src/server/tasacion
git commit -m "feat: tasacion coefficient tables (TTN, Ross-Heidecke) with interpolation"
```

---

### Task 5: Datos versionados + matching de barrios (TDD)

**Files:**
- Create: `src/server/tasacion/data/precios-barrio.json`, `src/server/tasacion/data/cocheras.json`, `src/server/tasacion/data/config-mercado.json`, `src/server/tasacion/data/README.md`
- Create: `src/server/tasacion/barrios.ts`
- Test: `src/server/tasacion/__tests__/barrios.test.ts`

- [ ] **Step 1: Crear los data files** (SOLO valores verificados 2026-06-12 — ver spec):

`src/server/tasacion/data/precios-barrio.json`:

```json
{
  "meta": {
    "descripcion": "USD/m² PUBLICADO (precio de oferta) para departamentos, por barrio CABA",
    "verificado": "2026-06-12",
    "actualizar": "mensual — ver README.md"
  },
  "fallback": { "usdM2": 2460, "fuente": "Zonaprop (vía Revista Mercado/La Nación)", "fecha": "2026-05" },
  "barrios": {
    "puerto madero": { "usdM2": 6140, "fuente": "Zonaprop (vía Revista Mercado)", "fecha": "2026-05" },
    "palermo": { "usdM2": 3403, "fuente": "Zonaprop (vía Revista Mercado)", "fecha": "2026-05" },
    "nunez": { "usdM2": 3392, "fuente": "Zonaprop (vía La Nación)", "fecha": "2026-05" },
    "saavedra": { "usdM2": 2852, "fuente": "Zonaprop (vía La Nación)", "fecha": "2026-05" },
    "colegiales": { "usdM2": 2679, "fuente": "Mudafy/Metrafy", "fecha": "2026-01" },
    "belgrano": { "usdM2": 2526, "fuente": "Mudafy", "fecha": "2026-01" },
    "recoleta": { "usdM2": 2459, "fuente": "Mudafy", "fecha": "2026-01" },
    "villa crespo": { "usdM2": 2085, "fuente": "Mudafy", "fecha": "2026-01" },
    "caballito": { "usdM2": 1952, "fuente": "Mudafy", "fecha": "2026-01" },
    "almagro": { "usdM2": 1818, "fuente": "Mudafy", "fecha": "2026-01" },
    "constitucion": { "usdM2": 1802, "fuente": "Zonaprop (vía La Nación)", "fecha": "2026-05" },
    "flores": { "usdM2": 1652, "fuente": "Mudafy", "fecha": "2026-01" },
    "nueva pompeya": { "usdM2": 1459, "fuente": "Zonaprop (vía Revista Mercado)", "fecha": "2026-05" },
    "villa lugano": { "usdM2": 1058, "fuente": "Zonaprop (vía La Nación)", "fecha": "2026-05" }
  }
}
```

`src/server/tasacion/data/cocheras.json`:

```json
{
  "meta": { "descripcion": "Valor cochera USD por barrio (punto medio de rangos publicados)", "verificado": "2026-06-12", "fuentes": "La Nación may/jun 2026, REMAX Buro II may 2026" },
  "default": 25000,
  "barrios": {
    "puerto madero": 50000,
    "palermo": 42500,
    "recoleta": 36000,
    "colegiales": 35000,
    "belgrano": 32500,
    "caballito": 30000
  }
}
```

`src/server/tasacion/data/config-mercado.json`:

```json
{
  "co": 0.9486,
  "brecha": "-5.14%",
  "fuente": "UCEMA Índice M2 Real (RE/MAX + Reporte Inmobiliario)",
  "fecha": "2026-01",
  "verificado": "2026-06-12"
}
```

`src/server/tasacion/data/README.md`:

```md
# Datos de mercado para tasación — actualización mensual

| Archivo | Qué actualizar | Fuente |
| --- | --- | --- |
| `precios-barrio.json` | USD/m² publicado por barrio | Zonaprop Index: https://www.zonaprop.com.ar/blog/zpindex/ (o cobertura de prensa) · Mudafy: https://mudafy.com.ar/d/valor-metro-cuadrado-en-caba-por-barrio |
| `config-mercado.json` | `co` = 1 + brecha publicado→cierre | UCEMA Índice M2 Real: https://ucema.edu.ar/novedad/ultimo-informe-indice-metro-cuadrado-real |
| `cocheras.json` | Valor cochera por barrio | Prensa (La Nación propiedades) / REMAX |

Reglas: claves de barrio en minúsculas y sin acentos; cada valor lleva `fuente` y `fecha`; NO cargar valores sin verificar la fuente.
```

- [ ] **Step 2: Test que falla** — `src/server/tasacion/__tests__/barrios.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import precios from '../data/precios-barrio.json';
import { matchBarrio, valorCochera } from '../barrios';

describe('precios-barrio.json (schema)', () => {
  it('todo barrio tiene usdM2 > 0, fuente y fecha', () => {
    for (const [nombre, v] of Object.entries(precios.barrios)) {
      expect(nombre).toBe(nombre.toLowerCase());
      expect(v.usdM2).toBeGreaterThan(0);
      expect(v.fuente.length).toBeGreaterThan(0);
      expect(v.fecha).toMatch(/^\d{4}-\d{2}$/);
    }
    expect(precios.fallback.usdM2).toBeGreaterThan(0);
  });
});

describe('matchBarrio', () => {
  it('matchea exacto, con mayúsculas y acentos', () => {
    expect(matchBarrio('Palermo').usdM2).toBe(3403);
    expect(matchBarrio('NÚÑEZ').usdM2).toBe(3392);
    expect(matchBarrio('Constitución').fallback).toBe(false);
  });
  it('resuelve alias y sub-barrios', () => {
    expect(matchBarrio('Lugano').usdM2).toBe(1058);
    expect(matchBarrio('Barrio Norte').usdM2).toBe(2459); // → recoleta
    expect(matchBarrio('Palermo Soho').usdM2).toBe(3403);
    expect(matchBarrio('Las Cañitas').usdM2).toBe(3403);
  });
  it('barrio desconocido o null → fallback CABA promedio con flag', () => {
    const m = matchBarrio('Marte');
    expect(m.fallback).toBe(true);
    expect(m.usdM2).toBe(2460);
    expect(matchBarrio(null).fallback).toBe(true);
  });
});

describe('valorCochera', () => {
  it('devuelve el valor del barrio o el default', () => {
    expect(valorCochera('Palermo')).toBe(42500);
    expect(valorCochera('Marte')).toBe(25000);
    expect(valorCochera(null)).toBe(25000);
  });
});
```

Run: `pnpm run test:unit -- tasacion/__tests__/barrios` → FAIL.

- [ ] **Step 3: Implementar `src/server/tasacion/barrios.ts`**:

```ts
import cocheras from './data/cocheras.json';
import precios from './data/precios-barrio.json';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Alias y sub-barrios → clave de la tabla (claves ya normalizadas). */
const ALIAS: Record<string, string> = {
  lugano: 'villa lugano',
  'barrio norte': 'recoleta',
  'palermo soho': 'palermo',
  'palermo hollywood': 'palermo',
  'palermo chico': 'palermo',
  'palermo viejo': 'palermo',
  'las canitas': 'palermo',
  pompeya: 'nueva pompeya',
};

export interface BarrioMatch {
  barrioUsado: string; // clave usada en la tabla (o "CABA promedio")
  usdM2: number;
  fuente: string;
  fecha: string;
  fallback: boolean;
}

const BARRIOS = precios.barrios as Record<string, { usdM2: number; fuente: string; fecha: string }>;

export function matchBarrio(raw: string | null): BarrioMatch {
  const fb: BarrioMatch = { barrioUsado: 'CABA promedio', ...precios.fallback, fallback: true };
  if (!raw) return fb;
  const n = normalize(raw);
  const key = BARRIOS[n] ? n : ALIAS[n] && BARRIOS[ALIAS[n]] ? ALIAS[n] : undefined;
  if (key) return { barrioUsado: key, ...BARRIOS[key], fallback: false };
  // sub-zona que contiene un barrio conocido ("palermo nuevo" → "palermo")
  for (const k of Object.keys(BARRIOS)) {
    if (n.startsWith(k) || n.includes(k)) return { barrioUsado: k, ...BARRIOS[k], fallback: false };
  }
  return fb;
}

const COCHERAS = cocheras.barrios as Record<string, number>;

export function valorCochera(raw: string | null): number {
  if (!raw) return cocheras.default;
  const n = normalize(raw);
  const key = COCHERAS[n] ? n : ALIAS[n] && COCHERAS[ALIAS[n]] ? ALIAS[n] : undefined;
  if (key) return COCHERAS[key];
  for (const k of Object.keys(COCHERAS)) {
    if (n.startsWith(k) || n.includes(k)) return COCHERAS[k];
  }
  return cocheras.default;
}
```

- [ ] **Step 4:** Run `pnpm run test:unit -- tasacion/__tests__/barrios` → PASS. (Si jest no resuelve los imports JSON, verificar `resolveJsonModule: true` en tsconfig.)

- [ ] **Step 5: Commit**

```bash
git add src/server/tasacion
git commit -m "feat: verified market data files + barrio matching"
```

---

### Task 6: Motor de tasación (TDD exhaustivo)

**Files:**
- Create: `src/server/tasacion/engine.ts`
- Test: `src/server/tasacion/__tests__/engine.test.ts`

- [ ] **Step 1: Test que falla** — `src/server/tasacion/__tests__/engine.test.ts`:

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { tasar, TasacionInputError } from '../engine';
import type { TasacionInput } from '~/types';

const base: TasacionInput = {
  tipoPropiedad: 'departamento',
  barrio: 'Palermo',
  m2Cubiertos: 75,
  m2Semicubiertos: null,
  m2Balcon: 8,
  m2Descubiertos: null,
  piso: 5,
  tieneAscensor: true,
  ubicacionPlanta: 'frente',
  antiguedadAnios: 20,
  estadoConservacion: 2.0,
  tieneCochera: false,
  tieneBaulera: false,
  amenities: [],
  categoriaConstructiva: 'estandar',
  aEstrenar: false,
};

describe('tasar — validación de entrada', () => {
  it('rechaza casa/PH (v1 calibrada para departamentos)', () => {
    expect(() => tasar({ ...base, tipoPropiedad: 'casa' })).toThrow(TasacionInputError);
  });
  it('rechaza sin m² cubiertos', () => {
    expect(() => tasar({ ...base, m2Cubiertos: null })).toThrow(TasacionInputError);
  });
});

describe('tasar — cálculo', () => {
  it('caso Palermo de referencia: valor coherente y trazable', () => {
    const r = tasar(base);
    // supHom = 75 + 8×0.33 = 77.64
    expect(r.superficieHomogeneizada).toBeCloseTo(77.64, 2);
    // sanity: depto 75m² Palermo debería caer en un rango plausible
    expect(r.valorEstimadoUsd).toBeGreaterThan(180_000);
    expect(r.valorEstimadoUsd).toBeLessThan(330_000);
    expect(r.valorEstimadoUsd % 100).toBe(0); // redondeo a centenas
    expect(r.rangoUsd[0]).toBeLessThan(r.valorEstimadoUsd);
    expect(r.rangoUsd[1]).toBeGreaterThan(r.valorEstimadoUsd);
    expect(r.confianza).toBe('alta');
    expect(r.fuentePrecios.fallback).toBe(false);
    expect(r.breakdown.length).toBeGreaterThan(5);
  });

  it('la cochera suma su valor de barrio', () => {
    const sin = tasar(base);
    const con = tasar({ ...base, tieneCochera: true });
    // 42500 × cAntiguedad(≈0.95) — la cochera entra antes del ajuste por antigüedad
    expect(con.valorEstimadoUsd - sin.valorEstimadoUsd).toBeGreaterThan(30_000);
    expect(con.valorEstimadoUsd - sin.valorEstimadoUsd).toBeLessThan(46_000);
  });

  it('contrafrente vale menos que frente', () => {
    const frente = tasar(base);
    const contra = tasar({ ...base, ubicacionPlanta: 'contrafrente' });
    expect(contra.valorEstimadoUsd).toBeLessThan(frente.valorEstimadoUsd);
  });

  it('más antigüedad y peor estado deprecian (solo componente construcción)', () => {
    const nuevo = tasar({ ...base, antiguedadAnios: 5, estadoConservacion: 1.0 });
    const viejo = tasar({ ...base, antiguedadAnios: 60, estadoConservacion: 3.0 });
    expect(viejo.valorEstimadoUsd).toBeLessThan(nuevo.valorEstimadoUsd);
    // 60 años NO destruye el valor (el suelo no deprecia): cae menos del 35%
    expect(viejo.valorEstimadoUsd).toBeGreaterThan(nuevo.valorEstimadoUsd * 0.65);
  });

  it('a estrenar aplica premio', () => {
    const usado = tasar(base);
    const estrenar = tasar({ ...base, antiguedadAnios: 0, estadoConservacion: 1.0, aEstrenar: true });
    expect(estrenar.valorEstimadoUsd).toBeGreaterThan(usado.valorEstimadoUsd);
  });

  it('barrio desconocido usa fallback CABA, baja confianza y lo declara', () => {
    const r = tasar({ ...base, barrio: 'Narnia' });
    expect(r.fuentePrecios.fallback).toBe(true);
    expect(r.confianza).toBe('baja');
  });

  it('datos faltantes aplican defaults documentados como supuestos y bajan confianza', () => {
    const r = tasar({ ...base, antiguedadAnios: null, estadoConservacion: null, piso: null, ubicacionPlanta: null });
    expect(r.supuestos.length).toBeGreaterThanOrEqual(3);
    expect(r.confianza).toBe('media'); // 100 −10 −10 −5 −5 = 70
  });

  it('clampea valores absurdos', () => {
    const r = tasar({ ...base, antiguedadAnios: 300 });
    expect(r.valorEstimadoUsd).toBeGreaterThan(0); // 300 → clamp 120 años
    expect(r.supuestos.some((s) => s.includes('120'))).toBe(true);
  });
});
```

- [ ] **Step 2:** Run `pnpm run test:unit -- tasacion/__tests__/engine` → FAIL.

- [ ] **Step 3: Implementar `src/server/tasacion/engine.ts`**:

```ts
import { matchBarrio, valorCochera } from './barrios';
import {
  BAULERA_M2_DEFAULT,
  COEF_CALIDAD,
  COEF_ESTRENAR,
  COEF_SUPERFICIE,
  COEF_UBICACION,
  ESCALA_TABLE,
  FACTOR_EDIFICIO,
  VIDA_UTIL_ANIOS,
  coefAmenities,
  coefPiso,
  interpolate,
  rossHeideckeK,
} from './constants';
import config from './data/config-mercado.json';
import type { BreakdownItem, TasacionInput, TasacionResult } from '~/types';

export class TasacionInputError extends Error {}

const MAX_M2 = 1000;
const MAX_ANTIGUEDAD = 120;

function round100(v: number): number {
  return Math.round(v / 100) * 100;
}

/** Motor de tasación: código puro, cero LLM. Cada paso queda trazado en el breakdown. */
export function tasar(input: TasacionInput): TasacionResult {
  if (input.tipoPropiedad !== 'departamento') {
    throw new TasacionInputError(
      'La tasación v1 está calibrada solo para departamentos (la tabla de valores m² es de departamentos). Casas y PH tienen una dinámica de precios distinta.',
    );
  }
  if (!input.m2Cubiertos || input.m2Cubiertos <= 0) {
    throw new TasacionInputError('No pude determinar los m² cubiertos del inmueble — son imprescindibles para tasar.');
  }

  const supuestos: string[] = [];
  const breakdown: BreakdownItem[] = [];

  // ── 1. Superficie homogeneizada ──────────────────────────────────────────
  let m2Cub = input.m2Cubiertos;
  if (m2Cub > MAX_M2) {
    m2Cub = MAX_M2;
    supuestos.push(`m² cubiertos acotados a ${MAX_M2}`);
  }
  const supHom =
    m2Cub * COEF_SUPERFICIE.cubierta +
    (input.m2Semicubiertos ?? 0) * COEF_SUPERFICIE.semicubierta +
    (input.m2Balcon ?? 0) * COEF_SUPERFICIE.balcon +
    (input.m2Descubiertos ?? 0) * COEF_SUPERFICIE.descubierta +
    (input.tieneBaulera ? BAULERA_M2_DEFAULT * COEF_SUPERFICIE.baulera : 0);
  breakdown.push({
    concepto: 'Superficie homogeneizada',
    valor: `${supHom.toFixed(1)} m²`,
    efecto: `cub ${m2Cub} ×1.0 · semi ${input.m2Semicubiertos ?? 0} ×0.5 · balcón ${input.m2Balcon ?? 0} ×0.33 · desc ${input.m2Descubiertos ?? 0} ×0.2${input.tieneBaulera ? ' · baulera' : ''}`,
  });

  // ── 2. Precio base del barrio ────────────────────────────────────────────
  const barrio = matchBarrio(input.barrio);
  if (barrio.fallback) {
    supuestos.push(
      input.barrio
        ? `barrio "${input.barrio}" sin datos propios — se usó el promedio CABA (USD ${barrio.usdM2}/m²)`
        : `sin barrio — se usó el promedio CABA (USD ${barrio.usdM2}/m²)`,
    );
  }
  breakdown.push({
    concepto: `Valor m² publicado (${barrio.barrioUsado})`,
    valor: `USD ${barrio.usdM2}/m²`,
    efecto: `${barrio.fuente}, ${barrio.fecha}`,
  });

  // ── 3. Coeficientes hedónicos ────────────────────────────────────────────
  if (input.piso !== null && input.piso > 0 && input.tieneAscensor === null) {
    supuestos.push('se asumió edificio con ascensor');
  }
  const cPiso = coefPiso(input.piso, input.tieneAscensor);
  if (input.piso === null) supuestos.push('piso no informado — coeficiente neutro');
  breakdown.push({
    concepto: `Coef. piso${input.piso !== null ? ` (${input.piso === 0 ? 'PB' : `${input.piso}°`}${input.tieneAscensor === false ? ', sin ascensor' : ''})` : ''}`,
    valor: `×${cPiso.toFixed(2)}`,
  });

  const cUbic = input.ubicacionPlanta ? COEF_UBICACION[input.ubicacionPlanta] : 1.0;
  if (!input.ubicacionPlanta) supuestos.push('ubicación en planta no informada — coeficiente neutro');
  breakdown.push({ concepto: `Coef. ubicación (${input.ubicacionPlanta ?? 'desconocida'})`, valor: `×${cUbic.toFixed(2)}` });

  const cCalidad = input.categoriaConstructiva ? COEF_CALIDAD[input.categoriaConstructiva] : 1.0;
  if (!input.categoriaConstructiva) supuestos.push('categoría constructiva no informada — coeficiente neutro');
  breakdown.push({
    concepto: `Coef. calidad (${input.categoriaConstructiva ?? 'desconocida'})`,
    valor: `×${cCalidad.toFixed(2)}`,
  });

  const cEscala = interpolate(ESCALA_TABLE, supHom);
  breakdown.push({ concepto: 'Coef. escala por superficie', valor: `×${cEscala.toFixed(2)}` });

  const cAmen = coefAmenities(input.amenities.length);
  breakdown.push({
    concepto: `Coef. amenities (${input.amenities.length ? input.amenities.join(', ') : 'sin amenities'})`,
    valor: `×${cAmen.toFixed(2)}`,
  });

  const precioAjustado = barrio.usdM2 * cPiso * cUbic * cCalidad * cEscala * cAmen;

  // ── 4. Publicado → cierre ────────────────────────────────────────────────
  breakdown.push({
    concepto: 'Coef. de oferta (publicado → cierre)',
    valor: `×${config.co}`,
    efecto: `brecha ${config.brecha} — ${config.fuente}, ${config.fecha}`,
  });
  const valorMCM = precioAjustado * config.co * supHom;
  breakdown.push({ concepto: 'Valor método comparativo', valor: `USD ${round100(valorMCM).toLocaleString('es-AR')}` });

  // ── 5. Cochera ───────────────────────────────────────────────────────────
  const cochera = input.tieneCochera ? valorCochera(input.barrio) : 0;
  if (input.tieneCochera) {
    breakdown.push({ concepto: 'Cochera', valor: `+USD ${cochera.toLocaleString('es-AR')}` });
  }

  // ── 6. Antigüedad / estado (Ross-Heidecke sobre componente construcción) ──
  let antiguedad: number;
  if (input.antiguedadAnios === null) {
    antiguedad = 25;
    supuestos.push('antigüedad no informada — se asumieron 25 años');
  } else if (input.antiguedadAnios > MAX_ANTIGUEDAD) {
    antiguedad = MAX_ANTIGUEDAD;
    supuestos.push(`antigüedad acotada a ${MAX_ANTIGUEDAD} años`);
  } else {
    antiguedad = input.antiguedadAnios;
  }
  let estado: number;
  if (input.estadoConservacion === null) {
    estado = 2.5;
    supuestos.push('estado no informado — se asumió "normal" (2,5)');
  } else {
    estado = input.estadoConservacion;
  }
  const k = rossHeideckeK((antiguedad / VIDA_UTIL_ANIOS) * 100, estado);
  const cAntiguedad = 1 - k * FACTOR_EDIFICIO;
  breakdown.push({
    concepto: `Coef. antigüedad/estado (Ross-Heidecke: ${antiguedad} años, estado ${estado})`,
    valor: `×${cAntiguedad.toFixed(3)}`,
    efecto: `K=${k.toFixed(3)} aplicado al ${FACTOR_EDIFICIO * 100}% del valor (la construcción; el suelo no deprecia)`,
  });

  // ── 7. A estrenar ────────────────────────────────────────────────────────
  const cEstrenar = input.aEstrenar ? COEF_ESTRENAR : 1.0;
  if (input.aEstrenar) {
    supuestos.push(`premio "a estrenar" +${Math.round((COEF_ESTRENAR - 1) * 100)}% [supuesto de mercado]`);
    breakdown.push({ concepto: 'A estrenar', valor: `×${COEF_ESTRENAR}` });
  }

  const valor = (valorMCM + cochera) * cAntiguedad * cEstrenar;

  // ── 8. Confianza ─────────────────────────────────────────────────────────
  let score = 100;
  if (input.antiguedadAnios === null) score -= 10;
  if (input.estadoConservacion === null) score -= 10;
  if (input.piso === null) score -= 5;
  if (!input.ubicacionPlanta) score -= 5;
  if (barrio.fallback) score -= 30;
  const confianza = score >= 85 ? 'alta' : score >= 60 ? 'media' : 'baja';

  return {
    valorEstimadoUsd: round100(valor),
    rangoUsd: [round100(valor * 0.85), round100(valor * 1.15)],
    confianza,
    superficieHomogeneizada: Math.round(supHom * 100) / 100,
    breakdown,
    supuestos,
    fuentePrecios: { fuente: barrio.fuente, fecha: barrio.fecha, barrioUsado: barrio.barrioUsado, fallback: barrio.fallback },
  };
}
```

- [ ] **Step 4:** Run `pnpm run test:unit -- tasacion/__tests__/engine` → PASS (9 tests). Si el caso de referencia cae fuera del rango del test, verificá la cadena de coeficientes contra el spec — NO cambies los asserts.

- [ ] **Step 5: Commit**

```bash
git add src/server/tasacion
git commit -m "feat: tasacion engine (comparative method + Ross-Heidecke, pure code)"
```

---

### Task 7: Extracción LLM (TDD mock)

**Files:**
- Create: `src/server/llm/tasacion-extract.ts`
- Test: `src/server/llm/__tests__/tasacion-extract.test.ts`

- [ ] **Step 1: Test que falla**:

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { runTasacionExtract, TASACION_EXTRACT_MODEL } from '../tasacion-extract';

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('runTasacionExtract', () => {
  beforeEach(() => mockQuery.mockReset());

  it('extrae el TasacionInput y devuelve tokens', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        {
          type: 'result',
          subtype: 'success',
          structured_output: {
            tipoPropiedad: 'departamento',
            barrio: 'Palermo',
            m2Cubiertos: 75,
            m2Semicubiertos: null,
            m2Balcon: 8,
            m2Descubiertos: null,
            piso: 5,
            tieneAscensor: true,
            ubicacionPlanta: 'frente',
            antiguedadAnios: 20,
            estadoConservacion: 2,
            tieneCochera: true,
            tieneBaulera: false,
            amenities: ['pileta', 'gym'],
            categoriaConstructiva: 'buena_servicios',
            aEstrenar: false,
          },
          usage: { input_tokens: 60, output_tokens: 40 },
        },
      ]),
    );
    const { input, tokens } = await runTasacionExtract('depto 75m2 en palermo piso 5 frente...');
    expect(input.barrio).toBe('Palermo');
    expect(input.m2Cubiertos).toBe(75);
    expect(input.estadoConservacion).toBe(2);
    expect(tokens).toBe(100);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe(TASACION_EXTRACT_MODEL);
  });

  it('lanza en subtype de error', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution', usage: {} }]));
    await expect(runTasacionExtract('x')).rejects.toThrow(/extract failed/);
  });
});
```

Run: `pnpm run test:unit -- tasacion-extract` → FAIL.

- [ ] **Step 2: Implementar `src/server/llm/tasacion-extract.ts`** (mismo patrón que intake — getQuery de `./sdk`, json_schema):

```ts
import { getQuery, tokensFromUsage, type Usage } from './sdk';
import type { TasacionInput } from '~/types';

export const TASACION_EXTRACT_MODEL = 'claude-sonnet-4-6';
const EXTRACT_MAX_TURNS = 2; // structured output necesita >1 turno

const NULLABLE_NUM = { type: ['number', 'null'] } as const;
const NULLABLE_BOOL = { type: ['boolean', 'null'] } as const;

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    tipoPropiedad: { type: 'string', enum: ['departamento', 'casa', 'ph'] },
    barrio: { type: ['string', 'null'] },
    m2Cubiertos: NULLABLE_NUM,
    m2Semicubiertos: NULLABLE_NUM,
    m2Balcon: NULLABLE_NUM,
    m2Descubiertos: NULLABLE_NUM,
    piso: NULLABLE_NUM,
    tieneAscensor: NULLABLE_BOOL,
    ubicacionPlanta: { type: ['string', 'null'], enum: ['frente', 'lateral', 'contrafrente', 'interno', null] },
    antiguedadAnios: NULLABLE_NUM,
    estadoConservacion: { type: ['number', 'null'], enum: [1, 1.5, 2, 2.5, 3, 3.5, 4, null] },
    tieneCochera: { type: 'boolean' },
    tieneBaulera: { type: 'boolean' },
    amenities: { type: 'array', items: { type: 'string' } },
    categoriaConstructiva: {
      type: ['string', 'null'],
      enum: ['economica', 'estandar', 'buena', 'buena_servicios', 'premium', null],
    },
    aEstrenar: { type: 'boolean' },
  },
  required: [
    'tipoPropiedad',
    'barrio',
    'm2Cubiertos',
    'm2Semicubiertos',
    'm2Balcon',
    'm2Descubiertos',
    'piso',
    'tieneAscensor',
    'ubicacionPlanta',
    'antiguedadAnios',
    'estadoConservacion',
    'tieneCochera',
    'tieneBaulera',
    'amenities',
    'categoriaConstructiva',
    'aEstrenar',
  ],
  additionalProperties: false,
} as const;

const EXTRACT_PROMPT = `Sos un tasador que estructura datos de inmuebles de Buenos Aires. Extraé de la descripción los atributos para tasar. REGLA DE ORO: si un dato NO está en el texto (ni se puede inferir directamente), devolvé null — NO inventes.

Guías:
- "tipoPropiedad": departamento por default si dice "depto/departamento/ambientes en piso"; "ph" o "casa" solo si lo dice.
- "barrio": el barrio de CABA mencionado (ej. "Palermo", "Villa Crespo").
- Superficies en m²: cubiertos (interior), semicubiertos (galería techada), balcón, descubiertos (patio/terraza). "75 metros" sin aclarar = m2Cubiertos. Si da total y balcón ("80 m² con 8 de balcón") → cubiertos 72, balcón 8.
- "piso": número (PB/planta baja = 0). "tieneAscensor" solo si lo menciona.
- "ubicacionPlanta": frente/contrafrente/lateral/interno solo si lo dice.
- "antiguedadAnios": años de antigüedad. "a estrenar" → 0 y aEstrenar=true.
- "estadoConservacion" (escala Heidecke): 1=excelente/a estrenar/reciclado a nuevo, 1.5=muy bueno, 2=bueno, 2.5=normal/original bien mantenido, 3=regular/necesita pintura y detalles, 3.5=malo/a refaccionar, 4=muy malo. Solo si el texto da señales; si no, null.
- "amenities": lista de amenities mencionados (pileta, gym, sum, parrilla, laundry, seguridad...).
- "categoriaConstructiva": economica/estandar/buena/buena_servicios (buena con servicios centrales)/premium — inferir solo con señales claras (ej. "torre premium con amenities" → premium).

DESCRIPCIÓN:
`;

export async function runTasacionExtract(description: string): Promise<{ input: TasacionInput; tokens: number }> {
  const query = await getQuery();
  for await (const message of query({
    prompt: `${EXTRACT_PROMPT}${description}`,
    options: {
      model: TASACION_EXTRACT_MODEL,
      maxTurns: EXTRACT_MAX_TURNS,
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: INPUT_SCHEMA as Record<string, unknown> },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || !message.structured_output) {
        throw new Error(`tasacion extract failed: ${message.subtype}`);
      }
      return {
        input: message.structured_output as TasacionInput,
        tokens: tokensFromUsage(message.usage as Usage),
      };
    }
  }
  throw new Error('tasacion extract failed: stream ended without result');
}
```

> Nota: si el SDK rechaza `enum` con `null` adentro (json_schema estricto), sacá el `null` del array `enum` y dejá solo `type: ['string','null']` — verificalo con el test mock y dejá el schema que compile/valide.

- [ ] **Step 3:** Run `pnpm run test:unit -- tasacion-extract` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/llm/tasacion-extract.ts src/server/llm/__tests__/tasacion-extract.test.ts
git commit -m "feat: tasacion attribute extraction (single sonnet call)"
```

---

### Task 8: API route

**Files:**
- Create: `src/app/api/tasacion/route.ts`

- [ ] **Step 1: Crear `src/app/api/tasacion/route.ts`**:

```ts
import { NextResponse } from 'next/server';
import { runTasacionExtract } from '~/server/llm/tasacion-extract';
import { TasacionInputError, tasar } from '~/server/tasacion/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { description?: string };
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }
  try {
    const { input } = await runTasacionExtract(description);
    if (!input.barrio && !input.m2Cubiertos) {
      return NextResponse.json(
        { error: 'No pude detectar ni el barrio ni los m² en la descripción — son los datos mínimos para tasar.' },
        { status: 400 },
      );
    }
    const result = tasar(input);
    return NextResponse.json({ input, result });
  } catch (err) {
    if (err instanceof TasacionInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'tasación falló' }, { status: 500 });
  }
}
```

- [ ] **Step 2:** Run `pnpm run lint && pnpm run build` (timeout 600000ms) → ambos PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/tasacion
git commit -m "feat: POST /api/tasacion"
```

---

### Task 9: UI — tabs Buscar | Tasar

**Files:**
- Create: `src/containers/Tasacion/TasacionPage.tsx`, `src/containers/Tasacion/index.ts`
- Modify: `src/containers/Landing.tsx`, `src/containers/index.ts`

- [ ] **Step 1: Crear `src/containers/Tasacion/TasacionPage.tsx`**:

```tsx
'use client';

import { useState } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import type { TasacionInput, TasacionResult } from '~/types';

const CONF_COLOR: Record<TasacionResult['confianza'], 'success' | 'warning' | 'error'> = {
  alta: 'success',
  media: 'warning',
  baja: 'error',
};

export const TasacionPage = () => {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ input: TasacionInput; result: TasacionResult } | null>(null);

  const tasarInmueble = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch('/api/tasacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });
      const json = (await res.json()) as { input?: TasacionInput; result?: TasacionResult; error?: string };
      if (!res.ok || !json.result || !json.input) throw new Error(json.error ?? 'No se pudo tasar');
      setData({ input: json.input, result: json.result });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setLoading(false);
    }
  };

  const r = data?.result;
  const i = data?.input;

  return (
    <Stack spacing={2} width='100%' maxWidth='72rem' py={4}>
      <textarea
        style={{ width: '100%', minHeight: '8rem', fontFamily: 'inherit', fontSize: '1rem', padding: '0.75rem' }}
        placeholder='Describí el inmueble a tasar: barrio, m² (cubiertos y balcón), piso, frente/contrafrente, antigüedad, estado, cochera, amenities…'
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={loading}
        data-testid='tasacion-input'
      />
      <Button
        variant='contained'
        disabled={loading || description.trim().length < 30}
        onClick={tasarInmueble}
        data-testid='tasacion-button'
      >
        {loading ? (
          <>
            <CircularProgress size={18} sx={{ mr: 1 }} /> Tasando…
          </>
        ) : (
          'Tasar'
        )}
      </Button>
      {error && (
        <Typography color='error' variant='body2'>
          {error}
        </Typography>
      )}

      {r && i && (
        <Paper variant='outlined' sx={{ p: 3 }} data-testid='tasacion-result'>
          <Stack spacing={2}>
            <Stack direction='row' spacing={2} alignItems='baseline'>
              <Typography variant='h4'>USD {r.valorEstimadoUsd.toLocaleString('es-AR')}</Typography>
              <Typography variant='body2' color='text.secondary'>
                rango {r.rangoUsd[0].toLocaleString('es-AR')} – {r.rangoUsd[1].toLocaleString('es-AR')}
              </Typography>
              <Chip size='small' color={CONF_COLOR[r.confianza]} label={`confianza ${r.confianza}`} />
            </Stack>

            <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
              <Chip size='small' variant='outlined' label={`${i.barrio ?? 'sin barrio'}`} />
              <Chip size='small' variant='outlined' label={`${r.superficieHomogeneizada} m² hom.`} />
              {i.piso !== null && <Chip size='small' variant='outlined' label={i.piso === 0 ? 'PB' : `piso ${i.piso}`} />}
              {i.antiguedadAnios !== null && <Chip size='small' variant='outlined' label={`${i.antiguedadAnios} años`} />}
              {i.tieneCochera && <Chip size='small' variant='outlined' label='cochera' />}
              {i.aEstrenar && <Chip size='small' variant='outlined' label='a estrenar' />}
            </Stack>

            <Accordion disableGutters variant='outlined'>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant='caption'>Cómo se calculó (breakdown coeficiente por coeficiente)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Table size='small'>
                  <TableBody>
                    {r.breakdown.map((b, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{b.concepto}</TableCell>
                        <TableCell align='right'>
                          <b>{b.valor}</b>
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{b.efecto ?? ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {r.supuestos.length > 0 && (
                  <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 1 }}>
                    Supuestos: {r.supuestos.join(' · ')}
                  </Typography>
                )}
              </AccordionDetails>
            </Accordion>

            <Typography variant='caption' color='text.secondary'>
              Estimación automática (±15%) basada en valores publicados de mercado ({r.fuentePrecios.fuente},{' '}
              {r.fuentePrecios.fecha}). No reemplaza una tasación profesional.
            </Typography>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
};
```

`src/containers/Tasacion/index.ts`:

```ts
export * from './TasacionPage';
```

- [ ] **Step 2: Modificar `src/containers/Landing.tsx`** (tabs; la búsqueda queda montada al cambiar de tab para no perder una búsqueda en curso):

```tsx
'use client';

import { useState } from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { styled } from '@mui/material/styles';
import { SearchPage } from './Search';
import { TasacionPage } from './Tasacion';
import { DISCLAIMER_HEIGHT, SURROUND_HEIGHT } from '~/utils';

export const Landing = () => {
  const [tab, setTab] = useState(0);
  return (
    <LandingContainer>
      <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ alignSelf: 'center' }}>
        <Tab label='Buscar' />
        <Tab label='Tasar' />
      </Tabs>
      {/* display:none (no unmount) para no matar una búsqueda SSE en curso al cambiar de tab */}
      <Box sx={{ display: tab === 0 ? 'contents' : 'none' }}>
        <SearchPage />
      </Box>
      <Box sx={{ display: tab === 1 ? 'contents' : 'none' }}>
        <TasacionPage />
      </Box>
    </LandingContainer>
  );
};

const LandingContainer = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  minHeight: `calc(100vh - ${SURROUND_HEIGHT}rem - ${DISCLAIMER_HEIGHT}rem)`,
  padding: '0 8rem',
  alignItems: 'center',
  width: '100%',
});
```

> Si `display: 'contents'` rompe el layout de los children (Stacks con width 100%), usar `sx={{ display: tab === 0 ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', width: '100%' }}` en ambos Box.

Agregar a `src/containers/index.ts`: `export * from './Tasacion';`

- [ ] **Step 3:** Run `pnpm run lint && pnpm run build` (timeout 600000ms) → PASS. `pnpm run test:unit` → sin regresiones.

- [ ] **Step 4: Commit**

```bash
git add src/containers
git commit -m "feat: tasacion tab with value, confidence and coefficient breakdown"
```

---

### Task 10: Smokes + verificación final

- [ ] **Step 1: Smoke de tasación (consume cuota ~10k tokens, 1 llamada)** — `pnpm run dev` en background, esperar Ready, y:

```bash
curl -s -X POST http://localhost:3000/api/tasacion -H 'Content-Type: application/json' \
  -d '{"description":"Departamento de 3 ambientes en Palermo, 75 m2 cubiertos mas un balcon de 8 m2, quinto piso al frente con ascensor, 20 anos de antiguedad, muy buen estado, con cochera, edificio con pileta y gym."}' | head -c 3000
```

Expected: 200 con `input` (barrio Palermo, m2Cubiertos 75, piso 5...) y `result` con `valorEstimadoUsd` plausible (200k-350k USD para ese caso), `confianza: "alta"`, breakdown con ~8 items. También probar el caso de rechazo:

```bash
curl -s -X POST http://localhost:3000/api/tasacion -H 'Content-Type: application/json' \
  -d '{"description":"Casa de 200 m2 en San Isidro con jardin y pileta, 4 dormitorios, garage doble"}' | head -c 500
```

Expected: 400 con el mensaje de "solo departamentos" (o de barrio si aplica primero). Matar el dev server al final.

- [ ] **Step 2: Smoke de búsqueda batch (OPCIONAL — Argenprop puede estar bloqueado por reCAPTCHA)**: intentá una búsqueda corta vía UI o curl. Si el portal está bloqueado, la verificación del batch queda cubierta por los unit tests (partición + firma) — reportalo, no es bloqueante.

- [ ] **Step 3: Verificación final**

```bash
pnpm run lint && pnpm run prettier && pnpm run test:unit && pnpm run build
git status
```

Expected: todo verde (si prettier marca, `pnpm run prettier:fix` + recommit), working tree limpio.

- [ ] **Step 4: Commit final si quedó algo**

```bash
git add -A && git commit -m "chore: batch-eval + tasacion final cleanup" || echo "nothing to commit"
```

---

## Notas para el ejecutor

- **No setear `ANTHROPIC_API_KEY`** — auth vía suscripción Claude Code.
- Patrón SDK: SIEMPRE `getQuery` de `src/server/llm/sdk.ts` (dynamic import). NO `createRequire`, NO `@anthropic-ai/sdk/helpers/zod`.
- WSL /mnt/c: lint/build/hooks LENTOS (minutos). Timeouts generosos (build 600000ms). No cancelar commits. GPG deshabilitado en el repo.
- Los data files JSON llevan SOLO valores verificados (2026-06-12) — no agregar barrios sin fuente.
- eslint override para tests con `jest.mock` (import/order): si `tasacion-extract.test.ts` o el `evaluate.test.ts` reescrito chocan con el hook, agregarlos al override existente en `eslint.config.mjs` (donde están `intake.test.ts`/`evaluate.test.ts`).
