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
  it('keeps (flagged) a textual must that cannot be confirmed — solo excluye si lo contradice', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      // r2 (mascotas, must) viene 'met' pero la evidencia NO está en el texto → degrada a unknown.
      // Anti-alucinación sigue intacto (el 'met' falso no cuenta), pero unknown ya NO excluye: se marca.
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'jacuzzi inexistente' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
      ]),
    ];
    const out = rankResults(gated, evals, reqs, { replicas: 1 });
    expect(out.survivors).toHaveLength(1);
    expect(out.survivors[0].unconfirmedMusts).toBe(1);
    expect(out.survivors[0].requirementResults.find((v) => v.requirementId === 'r2')?.verdict).toBe('unknown');
  });

  it('excludes a listing only when a hard textual must is CONTRADICTED (not_met)', () => {
    const gated: GatedListing[] = [{ listing: mk('a'), numericVerdicts: [], failReason: undefined }];
    const evals = [
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'not_met', evidence: null }, // el aviso contradice "mascotas"
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

  it('keeps a survivor with a missing numeric must and flags it as unconfirmed', () => {
    const reqExpensas: Requirement = {
      id: 'r1',
      label: 'expensas ≤ 800k',
      hardness: 'must',
      kind: 'numeric',
      predicate: { field: 'expensas', op: '<=', value: 800_000 },
    };
    // el gate ya resolvió dato faltante → unknown sin excluir (failReason undefined)
    const gated: GatedListing[] = [
      {
        listing: mk('a'),
        numericVerdicts: [{ requirementId: 'r1', verdict: 'unknown', evidence: null }],
        failReason: undefined,
      },
    ];
    const out = rankResults(gated, [], [reqExpensas], { replicas: 1 });
    expect(out.survivors).toHaveLength(1);
    expect(out.survivors[0].unconfirmedMusts).toBe(1);
  });

  it('ranks fully-confirmed survivors above ones with unconfirmed musts (even if pricier)', () => {
    const reqM2: Requirement = {
      id: 'r1',
      label: 'm² ≥ 100',
      hardness: 'must',
      kind: 'numeric',
      predicate: { field: 'm2', op: '>=', value: 100 },
    };
    const gated: GatedListing[] = [
      {
        listing: mk('missing', { price: { amount: 100_000, currency: 'USD' } }),
        numericVerdicts: [{ requirementId: 'r1', verdict: 'unknown', evidence: null }],
        failReason: undefined,
      },
      {
        listing: mk('confirmed', { price: { amount: 200_000, currency: 'USD' } }),
        numericVerdicts: [{ requirementId: 'r1', verdict: 'met', evidence: '120' }],
        failReason: undefined,
      },
    ];
    const out = rankResults(gated, [], [reqM2], { replicas: 1 });
    expect(out.survivors.map((s) => s.listing.id)).toEqual(['confirmed', 'missing']);
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

  it('orders survivors by niceScore desc (higher nice score first, regardless of price)', () => {
    const gated: GatedListing[] = [
      // a: cheaper but lower niceScore (only luminoso met = 1/3)
      { listing: mk('a', { price: { amount: 500_000, currency: 'ARS' } }), numericVerdicts: [], failReason: undefined },
      // b: pricier but higher niceScore (luminoso + cochera met = 3/3)
      { listing: mk('b', { price: { amount: 900_000, currency: 'ARS' } }), numericVerdicts: [], failReason: undefined },
    ];
    const evals = [
      ev('a', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: 'r4', verdict: 'not_met', evidence: null },
      ]),
      ev('b', 1, [
        { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
        { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
        { requirementId: 'r4', verdict: 'met', evidence: 'apto mascotas' }, // evidence substring real → cochera "met"
      ]),
    ];
    const out = rankResults(gated, evals, reqs, { replicas: 1 });
    // b has higher niceScore (3/3) so ranks first despite being pricier
    expect(out.survivors.map((s) => s.listing.id)).toEqual(['b', 'a']);
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
