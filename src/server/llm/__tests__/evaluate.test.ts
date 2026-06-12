/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { buildEvaluatePrompt, runEvaluator, EVALUATE_MODEL } from '../evaluate';

import type { NormalizedListing, Requirement } from '~/types';

import { RED_FLAGS_ID } from '~/types';

const l1: NormalizedListing = {
  id: 'l1',
  url: 'https://x/1',
  portal: 'argenprop',
  title: 'Depto A',
  price: { amount: 800_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'Luminoso, apto mascotas',
  detailDescription: 'Hermoso departamento luminoso, apto mascotas.',
  dataSource: 'detail',
};
const l2: NormalizedListing = { ...l1, id: 'l2', url: 'https://x/2', title: 'Depto B' };

const textualReqs: Requirement[] = [
  { id: 'r2', label: 'mascotas', hardness: 'must', kind: 'textual', statement: 'acepta mascotas' },
];

const verdictsFor = () => [
  { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
  { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
];

function resultMessage(results: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return { type: 'result', subtype: 'success', structured_output: { results }, usage };
}
function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('buildEvaluatePrompt (batch)', () => {
  it('includes every listing with its id, the requirements, and the red-flags instruction', () => {
    const p = buildEvaluatePrompt([l1, l2], textualReqs);
    expect(p).toContain('listingId="l1"');
    expect(p).toContain('listingId="l2"');
    expect(p).toContain('Depto B');
    expect(p).toContain('r2');
    expect(p).toContain(RED_FLAGS_ID);
  });
});

describe('runEvaluator (batch)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns one Evaluation per listing in the chunk', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        resultMessage([
          { listingId: 'l1', verdicts: verdictsFor() },
          { listingId: 'l2', verdicts: verdictsFor() },
        ]),
      ]),
    );
    const { evaluations, tokens } = await runEvaluator({ listings: [l1, l2], requirements: textualReqs, replica: 2 });
    expect(evaluations).toHaveLength(2);
    expect(evaluations[0]).toMatchObject({ listingId: 'l1', replica: 2 });
    expect(evaluations[1]).toMatchObject({ listingId: 'l2', replica: 2 });
    expect(tokens).toBe(120);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe(EVALUATE_MODEL);
    expect(opts.maxTurns).toBe(6);
  });

  it('drops results whose listingId is not in the chunk and tolerates missing listings', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        resultMessage([
          { listingId: 'l1', verdicts: verdictsFor() },
          { listingId: 'intruso', verdicts: verdictsFor() }, // id ajeno → se descarta
          // l2 ausente → simplemente no hay Evaluation para l2
        ]),
      ]),
    );
    const { evaluations } = await runEvaluator({ listings: [l1, l2], requirements: textualReqs, replica: 1 });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].listingId).toBe('l1');
  });

  it('throws on non-success subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_max_turns', usage: {} }]));
    await expect(runEvaluator({ listings: [l1], requirements: textualReqs, replica: 1 })).rejects.toThrow(
      /error_max_turns/,
    );
  });

  it('throws when structured_output.results is not an array', async () => {
    mockQuery.mockReturnValue(asyncGen([resultMessage(null)]));
    await expect(runEvaluator({ listings: [l1], requirements: textualReqs, replica: 1 })).rejects.toThrow(
      /not an array/,
    );
  });
});
