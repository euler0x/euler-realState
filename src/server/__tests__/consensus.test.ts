/** @jest-environment node */
import { expect } from '@jest/globals';
import type { NormalizedListing, Vote } from '~/types';
import { scoreListings, RED_FLAGS_LENS } from '../consensus';

const listing = (id: string): NormalizedListing => ({
  id,
  url: `https://example.com/${id}`,
  portal: 'argenprop',
  title: `Depto ${id}`,
  price: { amount: 500_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'lindo depto',
});

const vote = (lens: string, replica: number, verdicts: [string, 'match' | 'reject' | 'unsure'][]): Vote => ({
  lens,
  replica,
  verdicts: verdicts.map(([id, verdict]) => ({ id, verdict, reason: `${lens} says ${verdict}` })),
});

const OPTS = { threshold: 0.5, quorumMin: 2 };

describe('scoreListings', () => {
  it('scores by fraction of matching lenses and filters by threshold', () => {
    const pool = [listing('a'), listing('b')];
    const votes = [
      vote('precio', 1, [
        ['a', 'match'],
        ['b', 'reject'],
      ]),
      vote('espacio', 1, [
        ['a', 'match'],
        ['b', 'reject'],
      ]),
    ];
    const { results, degraded } = scoreListings(pool, votes, OPTS);
    expect(degraded).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0].listing.id).toBe('a');
    expect(results[0].score).toBe(1);
    expect(results[0].totalLenses).toBe(2);
  });

  it('resolves replica majority per lens; tie -> unsure (neutral)', () => {
    const pool = [listing('a')];
    const votes = [
      // precio: match vs reject -> tie -> unsure -> lens does not count as match
      vote('precio', 1, [['a', 'match']]),
      vote('precio', 2, [['a', 'reject']]),
      // espacio: 2x match
      vote('espacio', 1, [['a', 'match']]),
      vote('espacio', 2, [['a', 'match']]),
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results[0].score).toBe(0.5); // 1 of 2 lenses
    expect(results[0].matchedLenses).toBe(1);
    expect(results[0].totalLenses).toBe(2);
  });

  it('ignores unsure replicas when computing majority', () => {
    const pool = [listing('a')];
    const votes = [
      vote('precio', 1, [['a', 'unsure']]),
      vote('precio', 2, [['a', 'match']]),
      vote('espacio', 1, [['a', 'match']]),
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results[0].score).toBe(1);
  });

  it('red-flags lens marks but never scores nor hides', () => {
    const pool = [listing('a')];
    const votes = [
      vote('precio', 1, [['a', 'match']]),
      vote('espacio', 1, [['a', 'match']]),
      vote(RED_FLAGS_LENS, 1, [['a', 'reject']]), // red flags found
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results).toHaveLength(1);
    expect(results[0].redFlag).toBe(true);
    expect(results[0].totalLenses).toBe(2); // red-flags excluded
  });

  it('marks degraded when fewer scoring lenses than quorum responded', () => {
    const pool = [listing('a')];
    const votes = [vote('precio', 1, [['a', 'match']])];
    const { degraded } = scoreListings(pool, votes, { threshold: 0.5, quorumMin: 4 });
    expect(degraded).toBe(true);
  });

  it('a lens that never saw a listing does not count toward its total', () => {
    const pool = [listing('a'), listing('b')];
    const votes = [
      vote('precio', 1, [
        ['a', 'match'],
        ['b', 'match'],
      ]),
      vote('espacio', 1, [['a', 'match']]), // espacio never saw 'b'
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    const b = results.find((r) => r.listing.id === 'b');
    expect(b?.totalLenses).toBe(1); // only precio voted on b
    expect(b?.score).toBe(1); // absent lens = no signal, not a penalty
  });

  it('sorts results by score descending and keeps reasons', () => {
    const pool = [listing('a'), listing('b')];
    const votes = [
      vote('precio', 1, [
        ['a', 'match'],
        ['b', 'match'],
      ]),
      vote('espacio', 1, [
        ['a', 'reject'],
        ['b', 'match'],
      ]),
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results.map((r) => r.listing.id)).toEqual(['b', 'a']);
    expect(results[0].reasons.length).toBeGreaterThan(0);
    expect(results[0].reasons[0]).toHaveProperty('reason');
  });
});
