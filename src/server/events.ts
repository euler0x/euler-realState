import type { SearchEvent } from '~/types';

export type Listener = (e: SearchEvent) => void;

interface Channel {
  buffer: SearchEvent[];
  listeners: Set<Listener>;
}

// Keep recent channels replayable for SSE reconnects while bounding memory for a long-running
// local server — evict oldest entries when the cap is reached (Map preserves insertion order).
const MAX_CHANNELS = 50;

// Pin to globalThis like db.ts so the Map survives Next.js dev hot-reload (module re-execution).
const g = globalThis as typeof globalThis & { __inmueblesChannels?: Map<string, Channel> };
const channels: Map<string, Channel> = (g.__inmueblesChannels ??= new Map());

function channel(id: string): Channel {
  let ch = channels.get(id);
  if (!ch) {
    // Evict oldest entries before inserting so the Map stays under the cap.
    while (channels.size >= MAX_CHANNELS) {
      const oldest = channels.keys().next().value;
      if (oldest !== undefined) channels.delete(oldest);
      else break;
    }
    ch = { buffer: [], listeners: new Set() };
    channels.set(id, ch);
  }
  return ch;
}

export function emitSearchEvent(id: string, e: SearchEvent): void {
  const ch = channel(id);
  ch.buffer.push(e);
  for (const l of ch.listeners) {
    try {
      l(e);
    } catch {
      // a broken listener (e.g. closed SSE stream) must not stop delivery to the others
    }
  }
}

export function getBuffer(id: string): SearchEvent[] {
  return [...channel(id).buffer];
}

export function subscribe(id: string, listener: Listener): () => void {
  const ch = channel(id);
  ch.listeners.add(listener);
  return () => ch.listeners.delete(listener);
}

/**
 * Subscribe and snapshot the buffer atomically (no await between the two), so no event
 * can slip through the gap. Register the listener FIRST, then snapshot: any concurrently
 * emitted event is either already in the snapshot (emitted before) or delivered live to
 * the listener (emitted after) — never both, never neither (JS runs this synchronously).
 */
export function subscribeWithReplay(id: string, listener: Listener): { snapshot: SearchEvent[]; unsub: () => void } {
  const ch = channel(id);
  ch.listeners.add(listener);
  const snapshot = [...ch.buffer];
  return { snapshot, unsub: () => ch.listeners.delete(listener) };
}
