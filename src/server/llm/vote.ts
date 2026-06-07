import type { LensVerdict, NormalizedListing, SearchCriteria, Vote } from '~/types';
import type { Lens } from './lenses';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Memoized async accessor: resolves `query` via dynamic import on first call.
 * Dynamic import() is intercepted by jest.mock() in CJS transform mode (next/jest),
 * so the existing vote.test.ts mocks keep working.
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

/** Deterministic JSON: sorted keys so the cached prefix is byte-identical across replicas/runs. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * IMPORTANT for prompt caching: the shared context (criteria + pool) goes FIRST
 * and must be byte-identical across all lenses/replicas of a search. The lens
 * instruction goes at the END. Do not reorder.
 */
export function buildVotingPrompt(criteria: SearchCriteria, pool: NormalizedListing[], lens: Lens): string {
  const shared = [
    'Sos un evaluador de avisos inmobiliarios de Buenos Aires. Vas a recibir los criterios de búsqueda del usuario y una lista de avisos candidatos en JSON.',
    // stableStringify ensures the cache prefix is byte-identical regardless of key insertion order
    `CRITERIOS DE BÚSQUEDA:\n${stableStringify(criteria)}`,
    `AVISOS CANDIDATOS:\n${stableStringify(pool)}`,
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
  /** Override max turns (default: 4). structured output over a large pool needs several agent turns; too few returns error_max_turns. */
  maxTurns?: number;
}

export async function runVotingAgent(args: VotingAgentArgs): Promise<{ vote: Vote; tokens: number }> {
  // structured output over a large pool needs several agent turns; too few returns error_max_turns
  const { lens, replica, criteria, pool, model = VOTING_MODEL, timeoutMs = AGENT_TIMEOUT_MS, maxTurns = 4 } = args;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const query = await getQuery();
    for await (const message of query({
      prompt: buildVotingPrompt(criteria, pool, lens),
      options: {
        model,
        maxTurns,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: VERDICTS_SCHEMA as Record<string, unknown> },
      },
    })) {
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(`voting agent ${lens.key}#${replica} failed: ${message.subtype}`);
        }
        // After narrowing subtype === 'success', message is SDKResultSuccess.
        // structured_output is typed `unknown` by the SDK — single cast at extraction point.
        if (!message.structured_output) {
          throw new Error(`voting agent ${lens.key}#${replica} failed: ${message.subtype}`);
        }
        const { verdicts } = message.structured_output as { verdicts: LensVerdict[] };
        if (!Array.isArray(verdicts)) {
          throw new Error(`voting agent ${lens.key}#${replica}: invalid structured_output — verdicts is not an array`);
        }
        return {
          vote: { lens: lens.key, replica, verdicts },
          tokens: tokensFromUsage(message.usage),
        };
      }
    }
    throw new Error(`voting agent ${lens.key}#${replica}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
