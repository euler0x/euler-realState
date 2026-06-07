import type { SearchCriteria } from '~/types';
import { tokensFromUsage, type Usage } from './vote';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Memoized async accessor: resolves `query` via dynamic import on first call.
 * Dynamic import() is intercepted by jest.mock() in CJS transform mode (next/jest),
 * so the existing intake.test.ts mocks keep working.
 * Webpack also accepts ESM dynamic imports for externalized packages, unlike createRequire.
 */
type SdkModule = { query: (...args: unknown[]) => AsyncIterable<SDKMessage> };
let _sdk: SdkModule | undefined;
async function getQuery() {
  if (!_sdk) {
    _sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SdkModule;
  }
  return _sdk.query;
}

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
  const query = await getQuery();
  for await (const message of query({
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
