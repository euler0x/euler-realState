import { NextResponse } from 'next/server';
import { runTasacionExtract } from '~/server/llm/tasacion-extract';
import { TasacionInputError, tasar } from '~/server/tasacion/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { description?: string };
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }
  try {
    const { input } = await runTasacionExtract(description);
    if (!input.barrio && !input.m2Cubiertos) {
      return NextResponse.json(
        { error: 'No pude detectar ni el barrio ni los m² en la descripción — son los datos mínimos para tasar.' },
        { status: 400 },
      );
    }
    const result = tasar(input);
    return NextResponse.json({ input, result });
  } catch (err) {
    if (err instanceof TasacionInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'tasación falló' }, { status: 500 });
  }
}
