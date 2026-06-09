import type { SearchCriteria } from '~/types';
import { getQuery, tokensFromUsage, type Usage } from './sdk';

export const INTAKE_MODEL = 'claude-sonnet-4-6';
const INTAKE_MAX_TURNS = 2; // structured output necesita >1 turno

const REQUIREMENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    hardness: { type: 'string', enum: ['must', 'nice'] },
    kind: { type: 'string', enum: ['numeric', 'textual'] },
    predicate: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: ['m2', 'price', 'ambientes', 'expensas'] },
        op: { type: 'string', enum: ['>=', '<=', '=='] },
        value: { type: 'number' },
      },
      required: ['field', 'op', 'value'],
      additionalProperties: false,
    },
    statement: { type: 'string' },
    weight: { type: 'number' },
  },
  required: ['id', 'label', 'hardness', 'kind'],
  additionalProperties: false,
} as const;

const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['alquiler', 'venta'] },
    propertyType: { type: 'string', enum: ['departamento', 'casa', 'ph'] },
    barrios: { type: 'array', items: { type: 'string' } },
    currency: { type: 'string', enum: ['ARS', 'USD'] },
    requirements: { type: 'array', items: REQUIREMENT_SCHEMA },
  },
  required: ['operation', 'propertyType', 'barrios', 'currency', 'requirements'],
  additionalProperties: false,
} as const;

const INTAKE_PROMPT = `Sos un parser de búsquedas inmobiliarias de Buenos Aires. Convertí la descripción libre en criterios estructurados y una lista de REQUISITOS ATÓMICOS.

Reglas:
- "barrios": barrios de CABA/GBA mencionados o implicados (capitalizados). Vacío si no menciona zona.
- Cada requisito es UNA cosa concreta. Asignale:
  - "hardness": "must" si es innegociable (lenguaje: "al menos / mínimo / sí o sí / necesito / imprescindible", o cualquier requisito cuantificado concreto como m²/precio/dormitorios). "nice" si es un deseo blando ("ojalá / preferiblemente / estaría bueno", adjetivos como "luminoso/moderno").
  - "kind": "numeric" si se puede comparar con un número del aviso (m², precio, ambientes, expensas) → completá "predicate" {field, op, value}. Usá ">=" para mínimos ("al menos 165 m²", "3 dormitorios"), "<=" para topes ("hasta 900 mil"). "textual" para todo lo demás → completá "statement" (una afirmación a confirmar en el aviso, ej. "el aviso indica que acepta mascotas").
  - "id": un slug corto único (r1, r2, ...).
  - "weight" (solo nice): 1 por default; subilo a 2-3 si el usuario enfatizó ese deseo.
- "operation": si no se aclara, "alquiler". "propertyType": si no se aclara, "departamento". "currency": ARS para alquiler, USD para venta si no se aclara.

DESCRIPCIÓN:
`;

export async function runIntake(description: string): Promise<{ criteria: SearchCriteria; tokens: number }> {
  const query = await getQuery();
  for await (const message of query({
    prompt: `${INTAKE_PROMPT}${description}`,
    options: {
      model: INTAKE_MODEL,
      maxTurns: INTAKE_MAX_TURNS,
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: CRITERIA_SCHEMA as Record<string, unknown> },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || !message.structured_output) {
        throw new Error(`intake failed: ${message.subtype}`);
      }
      const parsed = message.structured_output as Omit<SearchCriteria, 'rawDescription'>;
      return { criteria: { ...parsed, rawDescription: description }, tokens: tokensFromUsage(message.usage as Usage) };
    }
  }
  throw new Error('intake failed: stream ended without result');
}
