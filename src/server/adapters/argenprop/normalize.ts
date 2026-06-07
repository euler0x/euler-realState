import { createHash } from 'crypto';
import type { NormalizedListing } from '~/types';

export interface RawArgenpropListing {
  url: string;
  title: string;
  priceText: string;
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

function extractNumber(features: string[], pattern: RegExp): number | undefined {
  for (const f of features) {
    const m = f.match(pattern);
    if (m) return Number(m[1]);
  }
  return undefined;
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
    barrio,
    ambientes: extractNumber(raw.featuresText, /(\d+)\s*amb/i),
    m2: extractNumber(raw.featuresText, /(\d+)\s*m²?/i),
    features: raw.featuresText.map((f) => f.trim()).filter(Boolean),
    description: truncateWords(`${raw.addressText}. ${raw.description}`),
  };
}
