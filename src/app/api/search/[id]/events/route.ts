import { subscribeWithReplay } from '~/server/events';
import type { SearchEvent } from '~/types';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // Use a ref object so `send` can close over it before the const is assigned;
      // subscribeWithReplay is synchronous so `ref.unsub` is populated before any listener fires.
      const ref = { unsub: () => {} };
      const send = (e: SearchEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (e.type === 'done' || e.type === 'error') {
          closed = true;
          ref.unsub();
          controller.close();
        }
      };
      // Atomic: register listener + get buffered snapshot with no gap (see events.ts).
      const { snapshot, unsub } = subscribeWithReplay(id, send);
      ref.unsub = unsub;
      for (const e of snapshot) send(e);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
