/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { buildEvaluatePrompt, runEvaluator, EVALUATE_MODEL } from '../evaluate';

import type { NormalizedListing, Requirement } from '~/types';

import { RED_FLAGS_ID } from '~/types';

const listing: NormalizedListing = {
  id: 'l1',
  url: 'https://x/1',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 800_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'Luminoso, apto mascotas',
  detailDescription: 'Hermoso departamento luminoso, apto mascotas, mesada de mármol.',
  dataSource: 'detail',
};

const textualReqs: Requirement[] = [
  {
    id: 'r2',
    label: 'acepta mascotas',
    hardness: 'must',
    kind: 'textual',
    statement: 'el aviso indica que acepta mascotas',
  },
  { id: 'r3', label: 'luminoso', hardness: 'nice', kind: 'textual', statement: 'el aviso menciona que es luminoso' },
];

function resultMessage(verdicts: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return { type: 'result', subtype: 'success', structured_output: { verdicts }, usage };
}
function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('buildEvaluatePrompt', () => {
  it('includes the listing text, the textual requirements, and a red-flags instruction', () => {
    const p = buildEvaluatePrompt(listing, textualReqs);
    expect(p).toContain('apto mascotas');
    expect(p).toContain('r2');
    expect(p).toContain(RED_FLAGS_ID);
  });
});

describe('runEvaluator', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns one verdict per textual requirement and tokens', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        resultMessage([
          { requirementId: 'r2', verdict: 'met', evidence: 'apto mascotas' },
          { requirementId: 'r3', verdict: 'met', evidence: 'luminoso' },
          { requirementId: RED_FLAGS_ID, verdict: 'not_met', evidence: null },
        ]),
      ]),
    );
    const { evaluation, tokens } = await runEvaluator({ listing, requirements: textualReqs, replica: 1 });
    expect(evaluation.listingId).toBe('l1');
    expect(evaluation.replica).toBe(1);
    expect(evaluation.verdicts).toHaveLength(3);
    expect(tokens).toBe(120);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe(EVALUATE_MODEL);
    expect(opts.maxTurns).toBe(4);
  });

  it('throws on non-success subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_max_turns', usage: {} }]));
    await expect(runEvaluator({ listing, requirements: textualReqs, replica: 1 })).rejects.toThrow(/error_max_turns/);
  });

  it('throws when structured_output.verdicts is not an array', async () => {
    mockQuery.mockReturnValue(asyncGen([resultMessage(null)]));
    await expect(runEvaluator({ listing, requirements: textualReqs, replica: 1 })).rejects.toThrow(/not an array/);
  });
});
