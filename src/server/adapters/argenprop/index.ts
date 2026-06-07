import type { NormalizedListing } from '~/types';
import { normalizeListing } from './normalize';
import { parseListings } from './parse';
import { buildSearchUrls } from './url';
import type { AdapterResult, PortalAdapter } from '../types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const BLOCK_STATUSES = [403, 429, 503];

async function fetchPage(url: string): Promise<{ html?: string; blocked: boolean }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { blocked: BLOCK_STATUSES.includes(res.status) };
  const html = await res.text();
  return { html, blocked: false };
}

export const argenpropAdapter: PortalAdapter = {
  name: 'argenprop',
  tier: 'scraper',
  async search(criteria): Promise<AdapterResult> {
    const byId = new Map<string, NormalizedListing>();
    let blocked = false;

    for (const [i, url] of buildSearchUrls(criteria).entries()) {
      const barrio = criteria.barrios[i] ?? 'Capital Federal';
      try {
        const page = await fetchPage(url);
        if (!page.html) {
          blocked ||= page.blocked;
          continue;
        }
        const raws = parseListings(page.html);
        if (raws.length === 0 && /challenge|captcha|cloudflare/i.test(page.html)) {
          blocked = true;
          continue;
        }
        for (const raw of raws) {
          const listing = normalizeListing(raw, barrio);
          if (listing) byId.set(listing.id, listing);
        }
      } catch {
        // network error / timeout on one barrio: keep going with the rest
      }
    }

    if (byId.size === 0 && blocked) return { status: 'blocked', listings: [], detail: 'challenge o status de bloqueo' };
    return { status: 'ok', listings: [...byId.values()] };
  },
};
