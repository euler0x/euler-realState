import { createRequire } from 'node:module';
import type { SearchCriteria } from '~/types';
import { tokensFromUsage, type Usage } from './vote';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Lazy accessor: resolves `query` at call time, not at module-load time.
 * This lets jest.mock() intercept the import before intake.ts consumes it,
 * while also being compatible with native ESM (tsx, Next.js) via createRequire.
 */
const _require = createRequire(import.meta.url);
const getQuery = (): ((...args: unknown[]) => AsyncIterable<SDKMessage>) =>
  (_require('@anthropic-ai/claude-agent-sdk') as { query: (...args: unknown[]) => AsyncIterable<SDKMessage> }).query;

export const INTAKE_MODEL = 'claude-sonnet-4-6';

const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['alquiler', 'venta'] },
    propertyType: { type: 'string', enum: ['departamento', 'casa', 'ph'] },
    barrios: { type: 'array', items: { type: 'string' } },
    priceMin: { type: 'number' },
    priceMax: { type: 'number' },
    currency: { type: 'string', enum: ['ARS', 'USD'] },
    ambientesMin: { type: 'number' },
    m2Min: { type: 'number' },
    mustHaves: { type: 'array', items: { type: 'string' } },
    niceToHaves: { type: 'array', items: { type: 'string' } },
  },
  required: ['operation', 'propertyType', 'barrios', 'currency', 'mustHaves', 'niceToHaves'],
  additionalProperties: false,
} as const;

const INTAKE_PROMPT = `Sos un parser de búsquedas inmobiliarias de Buenos Aires. Convertí la siguiente descripción libre en criterios estructurados.
- "barrios": nombres de barrios de CABA/GBA mencionados o implicados (capitalizados, ej. "Villa Crespo"). Si no menciona zona, lista vacía.
- "mustHaves": requisitos explícitos e innegociables. "niceToHaves": deseos blandos.
- Si no se aclara operación, asumí alquiler. Si no se aclara tipo, asumí departamento. Si no se aclara moneda: ARS para alquiler, USD para venta.

DESCRIPCIÓN:
`;

export async function runIntake(description: string): Promise<{ criteria: SearchCriteria; tokens: number }> {
  for await (const message of getQuery()({
    prompt: `${INTAKE_PROMPT}${description}`,
    options: {
      model: INTAKE_MODEL,
      maxTurns: 1,
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: CRITERIA_SCHEMA as Record<string, unknown> },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || !message.structured_output) {
        throw new Error(`intake failed: ${message.subtype}`);
      }
      // structured_output is typed `unknown` by the SDK — single cast at extraction point.
      const parsed = message.structured_output as Omit<SearchCriteria, 'rawDescription'>;
      return {
        criteria: { ...parsed, rawDescription: description },
        tokens: tokensFromUsage(message.usage as Usage),
      };
    }
  }
  throw new Error('intake failed: stream ended without result');
}
