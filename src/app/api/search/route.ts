import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { argenpropAdapter } from '~/server/adapters/argenprop';
import { getDb } from '~/server/db';
import { emitSearchEvent } from '~/server/events';
import { runEvaluator } from '~/server/llm/evaluate';
import { runIntake } from '~/server/llm/intake';
import { runSearch } from '~/server/search';
import type { SearchCriteria, SearchParams } from '~/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clampInt(v: unknown, min: number, max: number, fb: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, Math.round(n)));
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
    tokenBudget: clampInt(body.tokenBudget, 50_000, 5_000_000, 500_000),
    criteria: (body.criteria as SearchCriteria | undefined) ?? undefined,
  };
  const id = randomUUID();
  const db = getDb();
  db.createSearch(id, params);
  void runSearch(id, params, {
    db,
    adapters: [argenpropAdapter],
    intake: runIntake,
    evaluate: runEvaluator,
    emit: (e) => emitSearchEvent(id, e),
  }).catch((err) => console.error(`search ${id} crashed:`, err));
  return NextResponse.json({ id });
}
