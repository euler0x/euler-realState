/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import type { NormalizedListing, SearchCriteria, SearchEvent, SearchParams, Vote } from '~/types';
import { openDb, type SearchDb } from '../db';
import { runSearch, type SearchDeps } from '../search';
import type { AdapterResult } from '../adapters/types';
import type { Lens } from '../llm/lenses';

const criteria: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo'],
  currency: 'ARS',
  mustHaves: [],
  niceToHaves: [],
  rawDescription: 'depto',
};

const listing: NormalizedListing = {
  id: 'l1',
  url: 'https://x.com/1',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 100, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'd',
};

const params: SearchParams = { description: 'depto', replicas: 1, threshold: 0.5, tokenBudget: 100_000 };

const LENSES_2: Lens[] = [
  { key: 'precio', instruction: 'precio' },
  { key: 'espacio', instruction: 'espacio' },
];

function makeDeps(db: SearchDb, events: SearchEvent[], overrides: Partial<SearchDeps> = {}): SearchDeps {
  return {
    db,
    adapters: [
      {
        name: 'argenprop',
        tier: 'scraper',
        search: async (): Promise<AdapterResult> => ({ status: 'ok', listings: [listing] }),
      },
    ],
    intake: async () => ({ criteria, tokens: 100 }),
    vote: async ({ lens, replica }) => ({
      vote: { lens: lens.key, replica, verdicts: [{ id: 'l1', verdict: 'match', reason: 'ok' }] } as Vote,
      tokens: 1000,
    }),
    emit: (e) => events.push(e),
    lenses: LENSES_2,
    quorumMin: 1,
    concurrency: 1, // deterministic: budget cutoff and call order depend on sequential execution
    ...overrides,
  };
}

describe('runSearch', () => {
  let db: SearchDb;
  let events: SearchEvent[];
  beforeEach(() => {
    db = openDb(':memory:');
    events = [];
  });
  afterEach(() => db.close());

  it('runs the full pipeline and persists everything', async () => {
    db.createSearch('s1', params);
    await runSearch('s1', params, makeDeps(db, events));

    expect(db.getSearch('s1')?.status).toBe('done');
    expect(db.getPool('s1')).toHaveLength(1);
    expect(db.getVotes('s1')).toHaveLength(2); // 2 lenses x 1 replica
    expect(db.getResults('s1')?.results).toHaveLength(1);

    const phases = events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['intake', 'acquisition', 'voting', 'consensus']);
    expect(events.at(-1)).toMatchObject({ type: 'done', resultCount: 1, partial: false });
  });

  it('stops voting when the token budget is exceeded (partial consensus)', async () => {
    db.createSearch('s1', { ...params, tokenBudget: 1050 }); // intake 100 + 1 vote 1000 > budget
    await runSearch('s1', { ...params, tokenBudget: 1050 }, makeDeps(db, events));

    expect(db.getVotes('s1').length).toBeLessThan(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', partial: true });
    expect(events.some((e) => e.type === 'agent' && e.status === 'skipped')).toBe(true);
  });

  it('a failing adapter does not kill the search', async () => {
    db.createSearch('s1', params);
    const deps = makeDeps(db, events, {
      adapters: [
        { name: 'broken', tier: 'api', search: async () => Promise.reject(new Error('boom')) },
        { name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'ok' as const, listings: [listing] }) },
      ],
    });
    await runSearch('s1', params, deps);
    expect(db.getSearch('s1')?.status).toBe('done');
    expect(events.some((e) => e.type === 'adapter' && e.portal === 'broken' && e.status === 'error')).toBe(true);
  });

  it('empty pool ends the search with an error event', async () => {
    db.createSearch('s1', params);
    const deps = makeDeps(db, events, {
      adapters: [
        {
          name: 'argenprop',
          tier: 'scraper',
          search: async () => ({ status: 'blocked' as const, listings: [] }),
        },
      ],
    });
    await runSearch('s1', params, deps);
    expect(db.getSearch('s1')?.status).toBe('error');
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('respects the budget under concurrency=4 (bounded overshoot)', async () => {
    const budget = 200_000;
    db.createSearch('s1', { ...params, tokenBudget: budget });
    const manyLenses: Lens[] = Array.from({ length: 8 }, (_, i) => ({ key: `lens${i}`, instruction: 'x' }));
    let votesRun = 0;
    const deps = makeDeps(db, events, {
      tokenBudget: budget,
      lenses: manyLenses,
      concurrency: 4,
      quorumMin: 1,
      vote: async ({ lens, replica }) => {
        votesRun++;
        return {
          vote: { lens: lens.key, replica, verdicts: [{ id: 'l1', verdict: 'match', reason: 'ok' }] },
          tokens: 50_000,
        };
      },
    });
    // note: makeDeps spreads params for createSearch separately; ensure the run uses budget too
    await runSearch('s1', { ...params, tokenBudget: budget }, deps);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    // with reservation at 60k est and 50k actual, ~ floor(200k/ ~50k) votes run, not all 8
    expect(votesRun).toBeLessThan(8);
    expect(votesRun).toBeGreaterThan(0);
  });

  it('a failing voting agent loses its vote but not the search', async () => {
    db.createSearch('s1', params);
    const deps = makeDeps(db, events, {
      vote: jest
        .fn<SearchDeps['vote']>()
        .mockRejectedValueOnce(new Error('agent died'))
        .mockResolvedValue({
          vote: { lens: 'espacio', replica: 1, verdicts: [{ id: 'l1', verdict: 'match', reason: 'ok' }] },
          tokens: 10,
        }),
    });
    await runSearch('s1', params, deps);
    expect(db.getSearch('s1')?.status).toBe('done');
    expect(db.getVotes('s1')).toHaveLength(1);
    expect(events.some((e) => e.type === 'agent' && e.status === 'error')).toBe(true);
  });
});
