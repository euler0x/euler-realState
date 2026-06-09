/** @jest-environment node */
import { expect } from '@jest/globals';
import type { Evaluation, NormalizedListing, SearchOutput, SearchParams } from '~/types';
import { openDb, type SearchDb } from '../db';

const params: SearchParams = { description: 'depto en Palermo', replicas: 1, tokenBudget: 100_000 };

const listing: NormalizedListing = {
  id: 'abc',
  url: 'https://example.com/abc',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 100, currency: 'USD' },
  barrio: 'Palermo',
  features: ['balcón'],
  description: 'lindo',
  dataSource: 'card',
};

const evaluation: Evaluation = {
  listingId: 'abc',
  replica: 1,
  verdicts: [{ requirementId: 'r1', verdict: 'met', evidence: 'x' }],
};

describe('search db', () => {
  let db: SearchDb;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('creates and reads a search with status transitions', () => {
    db.createSearch('s1', params);
    expect(db.getSearch('s1')).toMatchObject({ id: 's1', status: 'pending', params });
    db.setStatus('s1', 'textual_eval');
    expect(db.getSearch('s1')?.status).toBe('textual_eval');
  });

  it('persists criteria, pool, evaluations and results', () => {
    db.createSearch('s1', params);
    db.saveCriteria('s1', {
      operation: 'alquiler',
      propertyType: 'departamento',
      barrios: ['Palermo'],
      currency: 'ARS',
      requirements: [],
      rawDescription: 'depto en Palermo',
    });
    db.savePool('s1', [listing]);
    db.saveEvaluation('s1', evaluation);

    const output: SearchOutput = { survivors: [], exclusions: [], unevaluable: [], degraded: false };
    db.saveResults('s1', output);

    expect(db.getPool('s1')).toEqual([listing]);
    expect(db.getEvaluations('s1')).toEqual([evaluation]);
    expect(db.getResults('s1')).toEqual(output);
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

  it('saveEvaluation upserts on retry (same listing_id + replica)', () => {
    db.createSearch('s1', params);
    const updated: Evaluation = {
      ...evaluation,
      verdicts: [{ requirementId: 'r1', verdict: 'not_met', evidence: null }],
    };
    db.saveEvaluation('s1', evaluation);
    db.saveEvaluation('s1', updated);
    expect(db.getEvaluations('s1')).toHaveLength(1);
    expect(db.getEvaluations('s1')[0].verdicts[0].verdict).toBe('not_met');
  });

  it('getPool and getEvaluations return empty arrays for missing search', () => {
    expect(db.getPool('nope')).toEqual([]);
    expect(db.getEvaluations('nope')).toEqual([]);
  });
});
