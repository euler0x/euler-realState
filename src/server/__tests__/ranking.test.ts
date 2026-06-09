/** @jest-environment node */
import { expect } from '@jest/globals';
import { RED_FLAGS_ID, type Evaluation, type NormalizedListing, type Requirement } from '~/types';
import { rankResults, type GatedListing } from '../ranking';

const mk = (id: string, over: Partial<NormalizedListing> = {}): NormalizedListing => ({
  id,
  url: `https://x/${id}`,
  portal: 'argenprop',
  title: `d${id}`,
  price: { amount: 500_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'apto mascotas, luminoso',
  detailDescription: 'apto mascotas, luminoso',
  dataSource: 'detail',
  ...over,
});

const reqMascotas: Requirement = { id: 'r2', label: 'mascotas', hardness: 'must', kind: 'textual', statement: 's' };
const reqLum: Requirement = {
  id: 'r3',
  label: 'luminoso',
  hardness: 'nice',
  kind: 'textual',
  statement: 's',
  weight: 1,
};
const reqCochera: Requirement = {
  id: 'r4',
  label: 'cochera',
  hardness: 'nice',
  kind: 'textual',
  statement: 's',
  weight: 2,
};
const reqs = [reqMascotas, reqLum, reqCochera];

const ev = (listingId: string, replica: number, verdicts: Evaluation['verdicts']): Evaluation => ({
  listingId,
  replica,
  verdicts,
});

describe('rankResults', () => {
  it('excludes a listing whose hard textual must-have is not confirmed (strict)', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      // r2 (mascotas, must) viene 'met' pero la evidencia NO está en el texto → degrada a unknown → excluye
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'jacuzzi inexistente' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
      ]),
    ];
    const out = rankResults(gated, evals, reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(0);
    expect(out.exclusions.some((b) => b.listingIds.includes('a'))).toBe(true);
  });

  it('keeps a listing whose hard must-have is confirmed with valid evidence, scores nice-to-haves', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' }, // substring real
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' }, // nice peso 1 → cumple
        { requirementId: 'r4', verdict: 'not_met', evidence: null }, // cochera nice peso 2 → no cumple
        { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
      ]),
    ];
    const out = rankResults(gated, evals, reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(1);
    // niceScore = peso cumplido (1) / peso total nice (1+2=3) = 0.333...
    expect(out.survivors[0].niceScore).toBeCloseTo(1 / 3, 3);
  });

  it('resolves replica majority per requirement (2 of 3 met with evidence → met)', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      ev('a', 1, [{ requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' }]),
      ev('a', 2, [{ requirementId: 'r2', verdict: 'not_met', evidence: null }]),
      ev('a', 3, [{ requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' }]),
    ];
    const out = rankResults(gated, evals, [reqMascotas], { replicas: 3 });
    expect(out.survivors).toHaveLength(1); // 2/3 met → pasa
  });

  it('propagates a numeric gate failure into an exclusion bucket', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: 'm² 50 no cumple >= 165' }];
    const out = rankResults(gated, [], reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(0);
    expect(out.exclusions.find((b) => b.reason === 'm² 50 no cumple >= 165')?.count).toBe(1);
  });

  it('sets redFlag from the special check and marks partialData', () => {
    const gated: GatedListing[] = [
      { listing: mk('a', { dataSource: 'card' }), numericVerdicts: [], failReason: undefined },
    ];
    const evals = [
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
        { requirementId: RED_FLAGS_ID, verdict: 'met', evidence: 'precio muy bajo' },
      ]),
    ];
    const out = rankResults(gated, evals, [reqMascotas], { replicas: 1 });
    expect(out.survivors[0].redFlag).toBe(true);
    expect(out.survivors[0].partialData).toBe(true);
  });

  it('orders survivors by niceScore desc then price asc', () => {
    const gated: GatedListing[] = [
      { listing: mk('a', { price: { amount: 700_000, currency: 'ARS' } }), numericVerdicts: [], failReason: undefined },
      { listing: mk('b', { price: { amount: 500_000, currency: 'ARS' } }), numericVerdicts: [], failReason: undefined },
    ];
    // ambos cumplen el must y mismo niceScore → desempata precio asc → b antes que a
    const mkEval = (id: string) =>
      ev(id, 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: 'r4', verdict: 'not_met', evidence: null },
      ]);
    const out = rankResults(gated, [mkEval('a'), mkEval('b')], reqs, { replicas: 1 });
    expect(out.survivors.map((s) => s.listing.id)).toEqual(['b', 'a']);
  });
});
