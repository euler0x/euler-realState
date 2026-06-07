import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { argenpropAdapter } from '~/server/adapters/argenprop';
import { getDb } from '~/server/db';
import { emitSearchEvent } from '~/server/events';
import { runIntake } from '~/server/llm/intake';
import { runVotingAgent } from '~/server/llm/vote';
import { runSearch } from '~/server/search';
import type { SearchParams } from '~/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }

  const params: SearchParams = {
    description,
    replicas: clampInt(body.replicas, 1, 4, 1),
    threshold: clampFloat(body.threshold, 0, 1, 0.6),
    tokenBudget: clampInt(body.tokenBudget, 50_000, 5_000_000, 500_000),
  };

  const id = randomUUID();
  const db = getDb();
  db.createSearch(id, params);

  void runSearch(id, params, {
    db,
    adapters: [argenpropAdapter],
    intake: runIntake,
    vote: runVotingAgent,
    emit: (e) => emitSearchEvent(id, e),
  }).catch((err) => {
    console.error(`search ${id} crashed:`, err);
  });

  return NextResponse.json({ id });
}
