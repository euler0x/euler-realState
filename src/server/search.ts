import type { NormalizedListing, SearchEvent, SearchParams } from '~/types';
import { scoreListings } from './consensus';
import { LENSES, type Lens } from './llm/lenses';
import type { PortalAdapter } from './adapters/types';
import type { SearchDb } from './db';
import type { runIntake } from './llm/intake';
import type { runVotingAgent } from './llm/vote';

export interface SearchDeps {
  db: SearchDb;
  adapters: PortalAdapter[];
  intake: typeof runIntake;
  vote: typeof runVotingAgent;
  emit: (e: SearchEvent) => void;
  lenses?: Lens[];
  concurrency?: number;
  quorumMin?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_QUORUM_MIN = 4;

// Conservative per-vote token estimate used for optimistic reservation only — actual cost
// is reconciled after the LLM returns. This keeps the circuit breaker meaningful at concurrency>1.
const ESTIMATED_VOTE_TOKENS = 60_000;

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runSearch(id: string, params: SearchParams, deps: SearchDeps): Promise<void> {
  const { db, emit } = deps;
  const lenses = deps.lenses ?? LENSES;
  let tokensUsed = 0;
  const trackTokens = (n: number) => {
    tokensUsed += n;
    emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
  };

  try {
    // 1. INTAKE
    db.setStatus(id, 'intake');
    emit({ type: 'phase', phase: 'intake' });
    const { criteria, tokens: intakeTokens } = await deps.intake(params.description);
    trackTokens(intakeTokens);
    db.saveCriteria(id, criteria);
    emit({ type: 'criteria', criteria });

    // 2. ACQUISITION (adapters are isolated: one failing doesn't kill the search)
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

    // 3. VOTING — circuit breaker with optimistic reservation: each in-flight vote reserves an
    // estimate so concurrent workers respect the budget; worst-case overshoot is bounded by one
    // vote's actual-vs-estimate delta.
    db.setStatus(id, 'voting');
    emit({ type: 'phase', phase: 'voting' });
    const jobs = lenses.flatMap((lens) =>
      Array.from({ length: params.replicas }, (_, i) => ({ lens, replica: i + 1 })),
    );
    let partial = false;
    await mapWithConcurrency(jobs, deps.concurrency ?? DEFAULT_CONCURRENCY, async ({ lens, replica }) => {
      if (tokensUsed >= params.tokenBudget) {
        partial = true;
        emit({ type: 'agent', lens: lens.key, replica, status: 'skipped' });
        return;
      }
      tokensUsed += ESTIMATED_VOTE_TOKENS; // reserve so concurrent workers see the in-flight cost
      emit({ type: 'agent', lens: lens.key, replica, status: 'running' });
      try {
        const { vote, tokens } = await deps.vote({ lens, replica, criteria, pool });
        tokensUsed += tokens - ESTIMATED_VOTE_TOKENS; // reconcile estimate → actual
        emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
        db.saveVote(id, vote);
        emit({ type: 'agent', lens: lens.key, replica, status: 'ok' });
      } catch {
        tokensUsed -= ESTIMATED_VOTE_TOKENS; // failed vote: release the reservation
        emit({ type: 'agent', lens: lens.key, replica, status: 'error' });
      }
    });

    // 4. CONSENSUS (pure code)
    db.setStatus(id, 'consensus');
    emit({ type: 'phase', phase: 'consensus' });
    const output = scoreListings(pool, db.getVotes(id), {
      threshold: params.threshold,
      quorumMin: deps.quorumMin ?? DEFAULT_QUORUM_MIN,
    });
    db.saveResults(id, output);
    db.setStatus(id, 'done');
    emit({ type: 'done', resultCount: output.results.length, degraded: output.degraded, partial });
  } catch (err) {
    db.setStatus(id, 'error');
    emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' });
  }
}
