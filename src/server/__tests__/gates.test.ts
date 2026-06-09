/** @jest-environment node */
import { expect } from '@jest/globals';
import type { NormalizedListing, Requirement } from '~/types';
import { applyNumericGates } from '../gates';

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

const m2min: Requirement = {
  id: 'r1',
  label: '≥165 m²',
  hardness: 'must',
  kind: 'numeric',
  predicate: { field: 'm2', op: '>=', value: 165 },
};
const priceMax: Requirement = {
  id: 'r2',
  label: '≤900k',
  hardness: 'must',
  kind: 'numeric',
  predicate: { field: 'price', op: '<=', value: 900_000 },
};
const niceM2: Requirement = {
  id: 'r3',
  label: '≥200 m²',
  hardness: 'nice',
  kind: 'numeric',
  predicate: { field: 'm2', op: '>=', value: 200 },
};

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
