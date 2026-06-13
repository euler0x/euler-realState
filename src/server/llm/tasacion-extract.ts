import type { TasacionInput } from '~/types';
import { getQuery, tokensFromUsage, type Usage } from './sdk';

export const TASACION_EXTRACT_MODEL = 'claude-sonnet-4-6';
const EXTRACT_MAX_TURNS = 2; // structured output necesita >1 turno

const NULLABLE_NUM = { type: ['number', 'null'] } as const;
const NULLABLE_BOOL = { type: ['boolean', 'null'] } as const;

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    tipoPropiedad: { type: 'string', enum: ['departamento', 'casa', 'ph'] },
    barrio: { type: ['string', 'null'] },
    direccion: { type: ['string', 'null'] },
    m2Cubiertos: NULLABLE_NUM,
    m2Semicubiertos: NULLABLE_NUM,
    m2Balcon: NULLABLE_NUM,
    m2Descubiertos: NULLABLE_NUM,
    piso: NULLABLE_NUM,
    tieneAscensor: NULLABLE_BOOL,
    ubicacionPlanta: {
      type: ['string', 'null'],
      enum: ['frente', 'lateral', 'contrafrente', 'interno', null] as (string | null)[],
    },
    antiguedadAnios: NULLABLE_NUM,
    estadoConservacion: { type: ['number', 'null'], enum: [1, 1.5, 2, 2.5, 3, 3.5, 4, null] as (number | null)[] },
    tieneCochera: { type: 'boolean' },
    tieneBaulera: { type: 'boolean' },
    amenities: { type: 'array', items: { type: 'string' } },
    categoriaConstructiva: {
      type: ['string', 'null'],
      enum: ['economica', 'estandar', 'buena', 'buena_servicios', 'premium', null] as (string | null)[],
    },
    aEstrenar: { type: 'boolean' },
  },
  required: [
    'tipoPropiedad',
    'barrio',
    'direccion',
    'm2Cubiertos',
    'm2Semicubiertos',
    'm2Balcon',
    'm2Descubiertos',
    'piso',
    'tieneAscensor',
    'ubicacionPlanta',
    'antiguedadAnios',
    'estadoConservacion',
    'tieneCochera',
    'tieneBaulera',
    'amenities',
    'categoriaConstructiva',
    'aEstrenar',
  ],
  additionalProperties: false,
} as const;

const EXTRACT_PROMPT = `Sos un tasador que estructura datos de inmuebles de Buenos Aires. Extraé de la descripción los atributos para tasar. REGLA DE ORO: si un dato NO está en el texto (ni se puede inferir directamente), devolvé null — NO inventes.

Guías:
- "tipoPropiedad": departamento por default si dice "depto/departamento/ambientes en piso"; "ph" o "casa" solo si lo dice.
- "barrio": el barrio de CABA mencionado (ej. "Palermo", "Villa Crespo").
- "direccion": calle y altura si aparecen (ej: "Pedro Goyena 600", "Av. Rivadavia 5000"); null si no hay dirección concreta.
- Superficies en m²: cubiertos (interior), semicubiertos (galería techada), balcón, descubiertos (patio/terraza). "75 metros" sin aclarar = m2Cubiertos. Si da total y balcón ("80 m² con 8 de balcón") → cubiertos 72, balcón 8.
- "piso": número (PB/planta baja = 0). "tieneAscensor" solo si lo menciona.
- "ubicacionPlanta": frente/contrafrente/lateral/interno solo si lo dice.
- "antiguedadAnios": años de antigüedad. "a estrenar" → 0 y aEstrenar=true.
- "estadoConservacion" (escala Heidecke): 1=excelente/a estrenar/reciclado a nuevo, 1.5=muy bueno, 2=bueno, 2.5=normal/original bien mantenido, 3=regular/necesita pintura y detalles, 3.5=malo/a refaccionar, 4=muy malo. Solo si el texto da señales; si no, null.
- "amenities": lista de amenities mencionados (pileta, gym, sum, parrilla, laundry, seguridad...).
- "categoriaConstructiva": economica/estandar/buena/buena_servicios (buena con servicios centrales)/premium — inferir solo con señales claras (ej. "torre premium con amenities" → premium).

DESCRIPCIÓN:
`;

export async function runTasacionExtract(description: string): Promise<{ input: TasacionInput; tokens: number }> {
  const query = await getQuery();
  for await (const message of query({
    prompt: `${EXTRACT_PROMPT}${description}`,
    options: {
      model: TASACION_EXTRACT_MODEL,
      maxTurns: EXTRACT_MAX_TURNS,
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: INPUT_SCHEMA as Record<string, unknown> },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || !message.structured_output) {
        throw new Error(`tasacion extract failed: ${message.subtype}`);
      }
      return {
        input: message.structured_output as TasacionInput,
        tokens: tokensFromUsage(message.usage as Usage),
      };
    }
  }
  throw new Error('tasacion extract failed: stream ended without result');
}
