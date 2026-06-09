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
}

const DEFAULT_CONCURRENCY = 4;
const ESTIMATED_EVAL_TOKENS = 40_000;

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
          emit({
            type: 'eval',
            listingId: listing.id,
            replica,
            status: 'error',
            detail: err instanceof Error ? err.message : String(err),
          });
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
