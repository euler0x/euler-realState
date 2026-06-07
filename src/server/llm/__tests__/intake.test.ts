/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { runIntake } from '../intake';

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('runIntake', () => {
  beforeEach(() => mockQuery.mockReset());

  it('parses the description into criteria and appends rawDescription', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        {
          type: 'result',
          subtype: 'success',
          structured_output: {
            operation: 'alquiler',
            propertyType: 'departamento',
            barrios: ['Palermo'],
            currency: 'ARS',
            priceMax: 900000,
            mustHaves: ['balcón'],
            niceToHaves: [],
          },
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      ]),
    );
    const { criteria, tokens } = await runIntake('depto en palermo con balcón hasta 900 mil');
    expect(criteria.operation).toBe('alquiler');
    expect(criteria.rawDescription).toBe('depto en palermo con balcón hasta 900 mil');
    expect(tokens).toBe(80);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('throws on failure subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution', usage: {} }]));
    await expect(runIntake('x')).rejects.toThrow(/intake failed/);
  });
});
