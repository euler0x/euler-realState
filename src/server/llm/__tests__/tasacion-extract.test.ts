/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { runTasacionExtract, TASACION_EXTRACT_MODEL } from '../tasacion-extract';

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('runTasacionExtract', () => {
  beforeEach(() => mockQuery.mockReset());

  it('extrae el TasacionInput y devuelve tokens', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        {
          type: 'result',
          subtype: 'success',
          structured_output: {
            tipoPropiedad: 'departamento',
            barrio: 'Palermo',
            m2Cubiertos: 75,
            m2Semicubiertos: null,
            m2Balcon: 8,
            m2Descubiertos: null,
            piso: 5,
            tieneAscensor: true,
            ubicacionPlanta: 'frente',
            antiguedadAnios: 20,
            estadoConservacion: 2,
            tieneCochera: true,
            tieneBaulera: false,
            amenities: ['pileta', 'gym'],
            categoriaConstructiva: 'buena_servicios',
            aEstrenar: false,
          },
          usage: { input_tokens: 60, output_tokens: 40 },
        },
      ]),
    );
    const { input, tokens } = await runTasacionExtract('depto 75m2 en palermo piso 5 frente...');
    expect(input.barrio).toBe('Palermo');
    expect(input.m2Cubiertos).toBe(75);
    expect(input.estadoConservacion).toBe(2);
    expect(tokens).toBe(100);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe(TASACION_EXTRACT_MODEL);
  });

  it('lanza en subtype de error', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution', usage: {} }]));
    await expect(runTasacionExtract('x')).rejects.toThrow(/extract failed/);
  });
});
