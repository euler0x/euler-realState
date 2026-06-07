/** @jest-environment node */
import { expect } from '@jest/globals';
import type { NormalizedListing, SearchParams, Vote } from '~/types';
import { openDb, type SearchDb } from '../db';

const params: SearchParams = { description: 'depto en Palermo', replicas: 1, threshold: 0.6, tokenBudget: 100_000 };

const listing: NormalizedListing = {
  id: 'abc',
  url: 'https://example.com/abc',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 100, currency: 'USD' },
  barrio: 'Palermo',
  features: ['balcón'],
  description: 'lindo',
};

const vote: Vote = { lens: 'precio', replica: 1, verdicts: [{ id: 'abc', verdict: 'match', reason: 'ok' }] };

describe('search db', () => {
  let db: SearchDb;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('creates and reads a search with status transitions', () => {
    db.createSearch('s1', params);
    expect(db.getSearch('s1')).toMatchObject({ id: 's1', status: 'pending', params });
    db.setStatus('s1', 'voting');
    expect(db.getSearch('s1')?.status).toBe('voting');
  });

  it('persists criteria, pool, votes and results', () => {
    db.createSearch('s1', params);
    db.saveCriteria('s1', {
      operation: 'alquiler',
      propertyType: 'departamento',
      barrios: ['Palermo'],
      currency: 'ARS',
      mustHaves: [],
      niceToHaves: [],
      rawDescription: 'depto en Palermo',
    });
    db.savePool('s1', [listing]);
    db.saveVote('s1', vote);
    db.saveResults('s1', { results: [], degraded: false });

    expect(db.getPool('s1')).toEqual([listing]);
    expect(db.getVotes('s1')).toEqual([vote]);
    expect(db.getResults('s1')).toEqual({ results: [], degraded: false });
  });

  it('savePool is idempotent per (search, listing)', () => {
    db.createSearch('s1', params);
    db.savePool('s1', [listing]);
    db.savePool('s1', [listing]);
    expect(db.getPool('s1')).toHaveLength(1);
  });

  it('returns undefined for missing search', () => {
    expect(db.getSearch('nope')).toBeUndefined();
    expect(db.getResults('nope')).toBeUndefined();
  });

  it('createSearch throws on duplicate id (ids are caller-generated uuids)', () => {
    db.createSearch('s1', params);
    expect(() => db.createSearch('s1', params)).toThrow();
  });

  it('saveVote upserts on retry (same lens+replica)', () => {
    db.createSearch('s1', params);
    const updated: Vote = { ...vote, verdicts: [{ id: 'abc', verdict: 'reject', reason: 'retry' }] };
    db.saveVote('s1', vote);
    db.saveVote('s1', updated);
    expect(db.getVotes('s1')).toHaveLength(1);
    expect(db.getVotes('s1')[0].verdicts[0].verdict).toBe('reject');
  });

  it('getPool and getVotes return empty arrays for missing search', () => {
    expect(db.getPool('nope')).toEqual([]);
    expect(db.getVotes('nope')).toEqual([]);
  });
});
