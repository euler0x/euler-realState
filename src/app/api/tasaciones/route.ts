import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDb } from '~/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { description?: string; input?: unknown; result?: unknown };
  if (!body.description || !body.input || !body.result) {
    return NextResponse.json({ error: 'payload incompleto' }, { status: 400 });
  }
  const id = randomUUID();
  getDb().saveTasacion(id, body.description, body.input, body.result);
  return NextResponse.json({ id });
}

export async function GET() {
  return NextResponse.json({ tasaciones: getDb().getTasaciones() });
}
