import {
  RED_FLAGS_ID,
  type Evaluation,
  type NormalizedListing,
  type Requirement,
  type RequirementVerdict,
} from '~/types';
import { getQuery, stableStringify, tokensFromUsage, type Usage } from './sdk';

export const EVALUATE_MODEL = 'claude-haiku-4-5';
const AGENT_TIMEOUT_MS = 180_000; // chunk de hasta 12 avisos tarda más que 1
const EVALUATE_MAX_TURNS = 6; // structured output grande (N avisos × M requisitos) necesita varios turnos

const VERDICT_ITEM = {
  type: 'object',
  properties: {
    requirementId: { type: 'string' },
    verdict: { type: 'string', enum: ['met', 'not_met', 'unknown'] },
    evidence: { type: ['string', 'null'] },
  },
  required: ['requirementId', 'verdict', 'evidence'],
  additionalProperties: false,
} as const;

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          listingId: { type: 'string' },
          verdicts: { type: 'array', items: VERDICT_ITEM },
        },
        required: ['listingId', 'verdicts'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

function listingText(listing: NormalizedListing): string {
  return [listing.title, listing.detailDescription ?? listing.description, (listing.amenities ?? []).join(', ')]
    .filter(Boolean)
    .join('\n');
}

/**
 * Prompt por LOTE: el prefijo (instrucciones + requisitos) es estable; los avisos van al final.
 * Amortiza el overhead fijo del Agent SDK (~25-30k tokens/llamada) entre todos los avisos del chunk.
 */
export function buildEvaluatePrompt(listings: NormalizedListing[], requirements: Requirement[]): string {
  const reqList = requirements.filter((r) => r.kind === 'textual').map((r) => ({ id: r.id, statement: r.statement }));
  const avisos = listings.map((l) => `### AVISO listingId="${l.id}"\n${listingText(l)}`).join('\n\n');
  return [
    'Sos un verificador estricto de avisos inmobiliarios de Buenos Aires. Vas a recibir VARIOS avisos. Para CADA aviso y CADA requisito, decidí si ESE aviso lo cumple, CITANDO el fragmento textual de ESE aviso que lo confirma.',
    'Reglas:',
    '- verdict "met" SOLO si el texto del aviso lo confirma, y "evidence" DEBE ser la cita textual exacta del aviso (copiada, no parafraseada).',
    '- verdict "not_met" si el aviso lo contradice. verdict "unknown" si el aviso no dice nada al respecto (NO inventes).',
    '- Si no podés citar evidencia textual, NO uses "met".',
    `- Por cada aviso, evaluá ADEMÁS el requisito especial "${RED_FLAGS_ID}": "met" si detectás RED FLAGS (precio sospechosamente bajo, descripción vaga/genérica, datos contradictorios), "not_met" si parece confiable, "unknown" si no hay info.`,
    '',
    `REQUISITOS (JSON):\n${stableStringify(reqList)}`,
    '',
    `AVISOS (${listings.length}):\n${avisos}`,
    '',
    `Devolvé en "results" una entrada por CADA aviso (usando exactamente su listingId), cada una con un verdict por requisito MÁS uno para "${RED_FLAGS_ID}".`,
  ].join('\n');
}

export interface EvaluatorArgs {
  listings: NormalizedListing[]; // chunk (1..CHUNK_SIZE avisos)
  requirements: Requirement[];
  replica: number;
  model?: string;
  timeoutMs?: number;
}

export async function runEvaluator(args: EvaluatorArgs): Promise<{ evaluations: Evaluation[]; tokens: number }> {
  const { listings, requirements, replica, model = EVALUATE_MODEL, timeoutMs = AGENT_TIMEOUT_MS } = args;
  const query = await getQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const tag = `evaluator chunk[${listings.length}]#${replica}`;
  try {
    for await (const message of query({
      prompt: buildEvaluatePrompt(listings, requirements),
      options: {
        model,
        maxTurns: EVALUATE_MAX_TURNS,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: BATCH_SCHEMA as Record<string, unknown> },
      },
    })) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || !message.structured_output) {
          throw new Error(`${tag} failed: ${message.subtype}`);
        }
        const { results } = message.structured_output as {
          results: { listingId: string; verdicts: RequirementVerdict[] }[];
        };
        if (!Array.isArray(results)) {
          throw new Error(`${tag}: invalid structured_output — results is not an array`);
        }
        const chunkIds = new Set(listings.map((l) => l.id));
        const evaluations: Evaluation[] = results
          .filter((r) => chunkIds.has(r.listingId) && Array.isArray(r.verdicts))
          .map((r) => ({ listingId: r.listingId, replica, verdicts: r.verdicts }));
        return { evaluations, tokens: tokensFromUsage(message.usage as Usage) };
      }
    }
    throw new Error(`${tag}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
