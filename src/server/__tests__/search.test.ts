/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import {
  RED_FLAGS_ID,
  type NormalizedListing,
  type SearchCriteria,
  type SearchEvent,
  type SearchParams,
} from '~/types';
import { openDb, type SearchDb } from '../db';
import { runSearch, type SearchDeps } from '../search';
import type { AdapterResult } from '../adapters/types';

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

const big: NormalizedListing = {
  id: 'big',
  url: 'https://x/big',
  portal: 'argenprop',
  title: 'grande',
  price: { amount: 100, currency: 'ARS' },
  barrio: 'Palermo',
  m2: 180,
  features: [],
  description: 'apto mascotas, luminoso',
  detailDescription: 'apto mascotas, luminoso',
  dataSource: 'detail',
};
const small: NormalizedListing = { ...big, id: 'small', url: 'https://x/small', m2: 50 };

const params: SearchParams = { description: 'depto', replicas: 1, tokenBudget: 1_000_000 };

function makeDeps(db: SearchDb, events: SearchEvent[], over: Partial<SearchDeps> = {}): SearchDeps {
  return {
    db,
    adapters: [
      {
        name: 'argenprop',
        tier: 'scraper',
        search: async (): Promise<AdapterResult> => ({ status: 'ok', listings: [big, small] }),
      },
    ],
    intake: async () => ({ criteria, tokens: 100 }),
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
    expect(out.survivors.map((s) => s.listing.id)).toEqual(['big']);
    expect(out.exclusions.some((b) => b.listingIds.includes('small'))).toBe(true);
    const evaluatedIds = evaluate.mock.calls.flatMap((c) =>
      (c[0] as { listings: NormalizedListing[] }).listings.map((l) => l.id),
    );
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
    await runSearch(
      's1',
      params,
      makeDeps(db, events, {
        adapters: [
          { name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'blocked' as const, listings: [] }) },
        ],
      }),
    );
    expect(db.getSearch('s1')?.status).toBe('error');
  });

  it('a failing evaluator on a hard req marks the listing unevaluable, not excluded as non-compliant', async () => {
    db.createSearch('s1', params);
    await runSearch(
      's1',
      { ...params },
      makeDeps(db, events, {
        evaluate: jest.fn<SearchDeps['evaluate']>().mockRejectedValue(new Error('agent died')),
      }),
    );
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

  it('partitions gate survivors into chunks of chunkSize × replicas', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...big, id: `b${i}`, url: `https://x/b${i}` }));
    db.createSearch('s1', { ...params, replicas: 2 });
    const evaluate = jest.fn(makeDeps(db, events).evaluate);
    await runSearch(
      's1',
      { ...params, replicas: 2 },
      makeDeps(db, events, {
        adapters: [
          { name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'ok' as const, listings: many }) },
        ],
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
});
