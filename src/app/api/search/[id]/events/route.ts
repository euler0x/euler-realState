import { subscribeWithReplay } from '~/server/events';
import type { SearchEvent } from '~/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();

  // Hoist ref outside start/cancel so both handlers share the same closed flag and unsub fn.
  const ref = { closed: false, unsub: () => {} };

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: SearchEvent) => {
        if (ref.closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (e.type === 'done' || e.type === 'error') {
          ref.closed = true;
          ref.unsub();
          controller.close();
        }
      };
      // Atomic: register listener + get buffered snapshot with no gap (see events.ts).
      const { snapshot, unsub } = subscribeWithReplay(id, send);
      ref.unsub = unsub;
      for (const e of snapshot) send(e);
    },
    cancel() {
      ref.closed = true;
      ref.unsub();
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
