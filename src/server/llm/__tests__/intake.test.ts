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

  it('parses description into base criteria + atomic requirements', async () => {
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
            requirements: [
              {
                id: 'r1',
                label: 'al menos 165 m²',
                hardness: 'must',
                kind: 'numeric',
                predicate: { field: 'm2', op: '>=', value: 165 },
              },
              {
                id: 'r2',
                label: 'acepta mascotas',
                hardness: 'must',
                kind: 'textual',
                statement: 'el aviso indica que acepta mascotas',
              },
              {
                id: 'r3',
                label: 'luminoso',
                hardness: 'nice',
                kind: 'textual',
                statement: 'el aviso menciona que es luminoso',
                weight: 1,
              },
            ],
          },
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      ]),
    );
    const { criteria, tokens } = await runIntake(
      'depto en palermo, mínimo 165 m2, que acepte mascotas, ojalá luminoso',
    );
    expect(criteria.operation).toBe('alquiler');
    expect(criteria.rawDescription).toContain('palermo');
    expect(criteria.requirements).toHaveLength(3);
    expect(criteria.requirements[0].predicate).toEqual({ field: 'm2', op: '>=', value: 165 });
    expect(criteria.requirements[1].hardness).toBe('must');
    expect(tokens).toBe(80);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('throws on failure subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution', usage: {} }]));
    await expect(runIntake('x')).rejects.toThrow(/intake failed/);
  });
});
