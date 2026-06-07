import { NextResponse } from 'next/server';
import { getDb } from '~/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const search = db.getSearch(id);
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ search, results: db.getResults(id) ?? null });
}
