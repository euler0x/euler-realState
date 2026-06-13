import {
  type Evaluation,
  type NormalizedListing,
  type SearchCriteria,
  type SearchEvent,
  type SearchParams,
} from '~/types';
import { applyNumericGates } from './gates';
import { rankResults, type GatedListing } from './ranking';
import type { PortalAdapter } from './adapters/types';
import type { SearchDb } from './db';
import type { runEvaluator } from './llm/evaluate';
import type { runIntake } from './llm/intake';

export interface SearchDeps {
  db: SearchDb;
  adapters: PortalAdapter[];
  intake: typeof runIntake;
  evaluate: typeof runEvaluator;
  emit: (e: SearchEvent) => void;
  concurrency?: number;
  chunkSize?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CHUNK_SIZE = 12;
const ESTIMATED_EVAL_TOKENS = 50_000; // reserva optimista POR CHUNK (reconciliada con el costo real)

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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

    db.setStatus(id, 'acquisition');
    emit({ type: 'phase', phase: 'acquisition' });
    const byId = new Map<string, NormalizedListing>();
    for (const adapter of deps.adapters) {
      emit({ type: 'adapter', portal: adapter.name, status: 'running' });
      try {
        const result = await adapter.search(criteria);
        for (const l of result.listings) byId.set(l.id, l);
        emit({
          type: 'adapter',
          portal: adapter.name,
          status: result.status,
          count: result.listings.length,
          detail: result.detail,
        });
      } catch (err) {
        emit({
          type: 'adapter',
          portal: adapter.name,
          status: 'error',
          detail: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    const pool = [...byId.values()];
    if (pool.length === 0) {
      db.setStatus(id, 'error');
      emit({ type: 'error', message: 'Ningún portal devolvió avisos (¿bloqueo o sin resultados?)' });
      return;
    }
    db.savePool(id, pool);

    db.setStatus(id, 'numeric_gate');
    emit({ type: 'phase', phase: 'numeric_gate' });
    const gated: GatedListing[] = pool.map((listing) => {
      const g = applyNumericGates(listing, criteria.requirements);
      return { listing, numericVerdicts: g.verdicts, failReason: g.passed ? undefined : g.failReason };
    });
    const survivorsOfGate = gated.filter((g) => !g.failReason);
    emit({ type: 'gate', survived: survivorsOfGate.length, total: pool.length });

    // Enriquecer detalle SOLO de los sobrevivientes del gate (no del pool paginado entero), ruteando
    // cada aviso a su portal de origen. Mutar g.listing también actualiza `gated` (mismas refs).
    const adaptersByName = new Map(deps.adapters.map((a) => [a.name, a]));
    const survivorsByPortal = new Map<string, GatedListing[]>();
    for (const g of survivorsOfGate) {
      const arr = survivorsByPortal.get(g.listing.portal) ?? [];
      arr.push(g);
      survivorsByPortal.set(g.listing.portal, arr);
    }
    for (const [portal, group] of survivorsByPortal) {
      const adapter = adaptersByName.get(portal);
      if (!adapter?.enrich) continue;
      try {
        const enriched = await adapter.enrich(group.map((g) => g.listing));
        const byId = new Map(enriched.map((l) => [l.id, l]));
        for (const g of group) g.listing = byId.get(g.listing.id) ?? g.listing;
      } catch {
        // enriquecido best-effort: si falla, seguimos con datos de tarjeta
      }
    }

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
          const { evaluations, tokens } = await deps.evaluate({
            listings,
            requirements: criteria.requirements,
            replica,
          });
          tokensUsed += tokens - ESTIMATED_EVAL_TOKENS;
          emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
          const returnedIds = new Set(evaluations.map((e) => e.listingId));
          for (const evaluation of evaluations) db.saveEvaluation(id, evaluation);
          for (const l of listings) {
            if (returnedIds.has(l.id)) {
              emit({ type: 'eval', listingId: l.id, replica, status: 'ok' });
            } else {
              emit({
                type: 'eval',
                listingId: l.id,
                replica,
                status: 'error',
                detail: 'sin veredictos en la respuesta del chunk',
              });
            }
          }
        } catch (err) {
          tokensUsed -= ESTIMATED_EVAL_TOKENS;
          const detail = err instanceof Error ? err.message : String(err);
          for (const l of listings) emit({ type: 'eval', listingId: l.id, replica, status: 'error', detail });
        }
      });
    }

    db.setStatus(id, 'ranking');
    emit({ type: 'phase', phase: 'ranking' });
    const evaluations: Evaluation[] = db.getEvaluations(id);
    const output = rankResults(gated, evaluations, criteria.requirements, { replicas: params.replicas });
    db.saveResults(id, output);
    db.setStatus(id, 'done');
    emit({
      type: 'done',
      resultCount: output.survivors.length,
      degraded: output.degraded,
      partial: tokensUsed >= params.tokenBudget,
    });
  } catch (err) {
    db.setStatus(id, 'error');
    emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' });
  }
}
