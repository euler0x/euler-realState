import { NextResponse } from 'next/server';
import { runTasacionExtract } from '~/server/llm/tasacion-extract';
import { TasacionInputError, tasar } from '~/server/tasacion/engine';
import { geocodeUSIG, microLookup } from '~/server/tasacion/geo';
import type { UbicacionInfo } from '~/types';

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
    // Geocodificación opcional: si falla, geo queda null y el motor degrada a nivel barrio.
    let geo: UbicacionInfo | null = null;
    if (input.direccion) {
      const point = await geocodeUSIG(input.direccion);
      if (point) {
        const cell = microLookup(point.lat, point.lon);
        geo = {
          ...point,
          multiplicador: cell?.multiplicador ?? 1,
          avisos: cell?.avisos ?? 0,
          smoothed: cell?.smoothed ?? false,
        };
      }
    }
    const result = tasar(input, geo);
    return NextResponse.json({ input, result });
  } catch (err) {
    if (err instanceof TasacionInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'tasación falló' }, { status: 500 });
  }
}
