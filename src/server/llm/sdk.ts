import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Memoized async accessor: resolves `query` via lazy dynamic import on first call.
 * Kept lazy so jest.mock() intercepts it in CJS transform mode (next/jest) and
 * so the SDK stays a runtime external (not bundled by webpack).
 */
export type SdkModule = { query: (...args: unknown[]) => AsyncIterable<SDKMessage> };
let _sdk: SdkModule | undefined;
export async function getQuery() {
  if (!_sdk) {
    _sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SdkModule;
  }
  return _sdk.query;
}

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
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
