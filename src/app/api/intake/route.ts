import { NextResponse } from 'next/server';
import { runIntake } from '~/server/llm/intake';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { description?: string };
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }
  try {
    const { criteria } = await runIntake(description);
    return NextResponse.json({ criteria });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'intake failed' }, { status: 500 });
  }
}
