import type { SearchEvent } from '~/types';

type Listener = (e: SearchEvent) => void;

interface Channel {
  buffer: SearchEvent[];
  listeners: Set<Listener>;
}

const channels = new Map<string, Channel>();

function channel(id: string): Channel {
  let ch = channels.get(id);
  if (!ch) {
    ch = { buffer: [], listeners: new Set() };
    channels.set(id, ch);
  }
  return ch;
}

export function emitSearchEvent(id: string, e: SearchEvent): void {
  const ch = channel(id);
  ch.buffer.push(e);
  for (const l of ch.listeners) l(e);
}

export function getBuffer(id: string): SearchEvent[] {
  return [...channel(id).buffer];
}

export function subscribe(id: string, listener: Listener): () => void {
  const ch = channel(id);
  ch.listeners.add(listener);
  return () => ch.listeners.delete(listener);
}
