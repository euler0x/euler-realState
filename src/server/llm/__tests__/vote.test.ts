/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { buildVotingPrompt, runVotingAgent, tokensFromUsage } from '../vote';

import { LENSES } from '../lenses';

import type { NormalizedListing, SearchCriteria } from '~/types';

const criteria: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo'],
  currency: 'ARS',
  mustHaves: ['balcón'],
  niceToHaves: [],
  rawDescription: 'depto 2 amb con balcón en Palermo',
};

const pool: NormalizedListing[] = [
  {
    id: 'l1',
    url: 'https://x.com/1',
    portal: 'argenprop',
    title: 'Depto',
    price: { amount: 800_000, currency: 'ARS' },
    barrio: 'Palermo',
    features: [],
    description: 'lindo',
  },
];

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: { verdicts: [{ id: 'l1', verdict: 'match', reason: 'tiene balcón' }] },
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
    ...overrides,
  };
}

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('buildVotingPrompt', () => {
  it('puts the shared context (criteria+pool) before the lens instruction (cache prefix)', () => {
    const p1 = buildVotingPrompt(criteria, pool, LENSES[0]);
    const p2 = buildVotingPrompt(criteria, pool, LENSES[1]);
    const sharedLen = [...p1].findIndex((c, i) => p2[i] !== c);
    expect(sharedLen).toBeGreaterThan(JSON.stringify(pool).length); // shared prefix covers the pool
    expect(p1).toContain(LENSES[0].instruction);
  });
});

describe('runVotingAgent', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns the structured vote and token count on success', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'system' }, resultMessage()]));
    const { vote, tokens } = await runVotingAgent({ lens: LENSES[0], replica: 1, criteria, pool });
    expect(vote).toEqual({
      lens: 'ubicacion',
      replica: 1,
      verdicts: [{ id: 'l1', verdict: 'match', reason: 'tiene balcón' }],
    });
    expect(tokens).toBe(125); // input + output + cache_creation (reads are ~free)
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe('claude-haiku-4-5');
    expect(opts.maxTurns).toBe(1);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.outputFormat).toMatchObject({ type: 'json_schema' });
  });

  it('throws on non-success result subtype', async () => {
    mockQuery.mockReturnValue(
      asyncGen([resultMessage({ subtype: 'error_max_structured_output_retries', structured_output: undefined })]),
    );
    await expect(runVotingAgent({ lens: LENSES[0], replica: 1, criteria, pool })).rejects.toThrow(
      /error_max_structured_output_retries/,
    );
  });

  it('throws on structured_output with missing verdicts array', async () => {
    mockQuery.mockReturnValue(asyncGen([resultMessage({ structured_output: { verdicts: null } })]));
    await expect(runVotingAgent({ lens: LENSES[0], replica: 1, criteria, pool })).rejects.toThrow(/not an array/);
  });

  it('throws when the stream ends without a result message', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'system' }]));
    await expect(runVotingAgent({ lens: LENSES[0], replica: 1, criteria, pool })).rejects.toThrow(/without result/);
  });
});

describe('tokensFromUsage', () => {
  it('sums input, output and cache_creation; ignores cache reads', () => {
    expect(
      tokensFromUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 100,
      }),
    ).toBe(6);
    expect(tokensFromUsage({})).toBe(0);
  });
});
