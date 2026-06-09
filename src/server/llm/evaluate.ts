import {
  RED_FLAGS_ID,
  type Evaluation,
  type NormalizedListing,
  type Requirement,
  type RequirementVerdict,
} from '~/types';
import { getQuery, stableStringify, tokensFromUsage, type Usage } from './sdk';

export const EVALUATE_MODEL = 'claude-haiku-4-5';
const AGENT_TIMEOUT_MS = 90_000;
const EVALUATE_MAX_TURNS = 4; // structured output sobre payload grande necesita varios turnos

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirementId: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'not_met', 'unknown'] },
          evidence: { type: ['string', 'null'] },
        },
        required: ['requirementId', 'verdict', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

function listingText(listing: NormalizedListing): string {
  return [listing.title, listing.detailDescription ?? listing.description, (listing.amenities ?? []).join(', ')]
    .filter(Boolean)
    .join('\n');
}

export function buildEvaluatePrompt(listing: NormalizedListing, requirements: Requirement[]): string {
  const reqList = requirements.filter((r) => r.kind === 'textual').map((r) => ({ id: r.id, statement: r.statement }));
  const text = listingText(listing);
  return [
    'Sos un verificador estricto de avisos inmobiliarios de Buenos Aires. Para CADA requisito, decidí si el aviso lo cumple, CITANDO el fragmento textual del aviso que lo confirma.',
    'Reglas:',
    '- verdict "met" SOLO si el texto del aviso lo confirma, y "evidence" DEBE ser la cita textual exacta del aviso (copiada, no parafraseada).',
    '- verdict "not_met" si el aviso lo contradice. verdict "unknown" si el aviso no dice nada al respecto (NO inventes).',
    '- Si no podés citar evidencia textual, NO uses "met".',
    `- Además, evaluá un requisito especial con id "${RED_FLAGS_ID}": verdict "met" si detectás RED FLAGS (precio sospechosamente bajo, descripción vaga/genérica, datos contradictorios), "not_met" si parece confiable, "unknown" si no hay info. La evidencia es la señal que viste.`,
    '',
    `REQUISITOS (JSON):\n${stableStringify(reqList)}`,
    '',
    `AVISO:\n${text}`,
    '',
    `Devolvé un verdict por cada requisito de la lista MÁS uno para "${RED_FLAGS_ID}".`,
  ].join('\n');
}

export interface EvaluatorArgs {
  listing: NormalizedListing;
  requirements: Requirement[];
  replica: number;
  model?: string;
  timeoutMs?: number;
}

export async function runEvaluator(args: EvaluatorArgs): Promise<{ evaluation: Evaluation; tokens: number }> {
  const { listing, requirements, replica, model = EVALUATE_MODEL, timeoutMs = AGENT_TIMEOUT_MS } = args;
  const query = await getQuery();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    for await (const message of query({
      prompt: buildEvaluatePrompt(listing, requirements),
      options: {
        model,
        maxTurns: EVALUATE_MAX_TURNS,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: VERDICTS_SCHEMA as Record<string, unknown> },
      },
    })) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || !message.structured_output) {
          throw new Error(`evaluator l=${listing.id}#${replica} failed: ${message.subtype}`);
        }
        const { verdicts } = message.structured_output as { verdicts: RequirementVerdict[] };
        if (!Array.isArray(verdicts)) {
          throw new Error(`evaluator l=${listing.id}#${replica}: invalid structured_output — verdicts is not an array`);
        }
        return {
          evaluation: { listingId: listing.id, replica, verdicts },
          tokens: tokensFromUsage(message.usage as Usage),
        };
      }
    }
    throw new Error(`evaluator l=${listing.id}#${replica}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
