import { createHash } from 'crypto';
import type { NormalizedListing } from '~/types';

export interface RawArgenpropListing {
  url: string;
  title: string;
  priceText: string;
  expensasText: string;
  addressText: string;
  featuresText: string[];
  description: string;
}

export function parsePrice(text: string): NormalizedListing['price'] | undefined {
  const cleaned = text.trim();
  if (!cleaned || /consultar/i.test(cleaned)) return undefined;
  const currency = /usd|u\$s/i.test(cleaned) ? 'USD' : 'ARS';
  const digits = cleaned.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  return { amount: Number(digits), currency };
}

export function truncateWords(s: string, n = 150): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= n) return s.trim();
  return `${words.slice(0, n).join(' ')}…`;
}

function extractNumber(texts: string[], pattern: RegExp): number | undefined {
  for (const t of texts) {
    const m = t.match(pattern);
    if (m) return Number(m[1]);
  }
  return undefined;
}

const AMB_RE = /(\d+)\s*amb/i;
const MONO_RE = /monoambiente/i;
const DORM_RE = /(\d+)\s*dorm/i;
const M2_RE = /(\d+)\s*m[²2]/i;

/**
 * Cantidad de ambientes. Argenprop la pone en el TÍTULO; la lista de features de la tarjeta
 * suele traer solo "X dorm." Prioridad: ambientes explícito en features → mono en features →
 * ambientes explícito en título → mono en título → dormitorios + 1 (living, convención CABA).
 * Sin esto, ambientes queda undefined y el gate estricto `ambientes == N` excluye todo el pool.
 */
function deriveAmbientes(features: string[], title: string): number | undefined {
  const fromFeatures = extractNumber(features, AMB_RE);
  if (fromFeatures !== undefined) return fromFeatures;
  if (features.some((f) => MONO_RE.test(f))) return 1;
  const fromTitle = title.match(AMB_RE);
  if (fromTitle) return Number(fromTitle[1]);
  if (MONO_RE.test(title)) return 1;
  const dorms = extractNumber(features, DORM_RE);
  return dorms !== undefined ? dorms + 1 : undefined;
}

export function normalizeListing(raw: RawArgenpropListing, barrio: string): NormalizedListing | null {
  if (!raw.url) return null;
  const price = parsePrice(raw.priceText);
  if (!price) return null;
  const canonicalUrl = raw.url.split('?')[0];
  return {
    id: createHash('sha1').update(canonicalUrl).digest('hex'),
    url: canonicalUrl,
    portal: 'argenprop',
    title: raw.title.trim(),
    price,
    expensas: parsePrice(raw.expensasText)?.amount,
    barrio,
    ambientes: deriveAmbientes(raw.featuresText, raw.title),
    m2: extractNumber([...raw.featuresText, raw.title], M2_RE),
    features: raw.featuresText.map((f) => f.trim()).filter(Boolean),
    description: truncateWords(`${raw.addressText}. ${raw.description}`),
    dataSource: 'card' as const,
  };
}
