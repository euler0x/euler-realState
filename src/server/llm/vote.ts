import { createRequire } from 'node:module';
import type { LensVerdict, NormalizedListing, SearchCriteria, Vote } from '~/types';
import type { Lens } from './lenses';

/**
 * Lazy accessor: resolves `query` at call time, not at module-load time.
 * This lets jest.mock() intercept the import before vote.ts consumes it,
 * while also being compatible with native ESM (tsx, Next.js) via createRequire.
 */
const _require = createRequire(import.meta.url);
const getQuery = (): ((...args: unknown[]) => AsyncIterable<unknown>) =>
  (_require('@anthropic-ai/claude-agent-sdk') as { query: (...args: unknown[]) => AsyncIterable<unknown> }).query;

export const VOTING_MODEL = 'claude-haiku-4-5';
const AGENT_TIMEOUT_MS = 90_000;

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['match', 'reject', 'unsure'] },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Cache reads cost ~10%; count the expensive components only. */
export function tokensFromUsage(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/**
 * IMPORTANT for prompt caching: the shared context (criteria + pool) goes FIRST
 * and must be byte-identical across all lenses/replicas of a search. The lens
 * instruction goes at the END. Do not reorder.
 */
export function buildVotingPrompt(criteria: SearchCriteria, pool: NormalizedListing[], lens: Lens): string {
  const shared = [
    'Sos un evaluador de avisos inmobiliarios de Buenos Aires. Vas a recibir los criterios de búsqueda del usuario y una lista de avisos candidatos en JSON.',
    `CRITERIOS DE BÚSQUEDA:\n${JSON.stringify(criteria)}`,
    `AVISOS CANDIDATOS:\n${JSON.stringify(pool)}`,
  ].join('\n\n');
  return `${shared}\n\nTU LENTE DE EVALUACIÓN:\n${lens.instruction}\n\nDevolvé un veredicto por CADA candidato, usando exactamente su campo "id". verdict: "match" (cumple tu lente), "reject" (no cumple), "unsure" (falta información para juzgar — NO uses reject si simplemente falta el dato).`;
}

export interface VotingAgentArgs {
  lens: Lens;
  replica: number;
  criteria: SearchCriteria;
  pool: NormalizedListing[];
  model?: string;
  timeoutMs?: number;
  /** Override max turns (default: 1). Useful for smoke runs with outputFormat: json_schema. */
  maxTurns?: number;
}

export async function runVotingAgent(args: VotingAgentArgs): Promise<{ vote: Vote; tokens: number }> {
  const { lens, replica, criteria, pool, model = VOTING_MODEL, timeoutMs = AGENT_TIMEOUT_MS, maxTurns = 1 } = args;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    for await (const rawMessage of getQuery()({
      prompt: buildVotingPrompt(criteria, pool, lens),
      options: {
        model,
        maxTurns,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: VERDICTS_SCHEMA as Record<string, unknown> },
      },
    })) {
      const message = rawMessage as Record<string, unknown>;
      if (message['type'] === 'result') {
        if (message['subtype'] !== 'success' || !('structured_output' in message) || !message['structured_output']) {
          throw new Error(`voting agent ${lens.key}#${replica} failed: ${message['subtype']}`);
        }
        const { verdicts } = message['structured_output'] as { verdicts: LensVerdict[] };
        return {
          vote: { lens: lens.key, replica, verdicts },
          tokens: tokensFromUsage(message['usage'] as Usage),
        };
      }
    }
    throw new Error(`voting agent ${lens.key}#${replica}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
