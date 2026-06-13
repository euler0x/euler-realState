import type { NormalizedListing } from '~/types';
import { parseDetail } from './detail';
import { normalizeListing } from './normalize';
import { parseListings } from './parse';
import { buildSearchUrls } from './url';
import type { AdapterResult, PortalAdapter } from '../types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const BLOCK_STATUSES = [403, 429, 503];
const DETAIL_CONCURRENCY = 5;
const DETAIL_DELAY_MS = 150;

async function fetchPage(url: string): Promise<{ html?: string; blocked: boolean }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { blocked: BLOCK_STATUSES.includes(res.status) };
  const html = await res.text();
  return { html, blocked: false };
}

async function enrichWithDetail(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
  const queue = [...listings];
  const out: NormalizedListing[] = [];
  const worker = async () => {
    for (let l = queue.shift(); l !== undefined; l = queue.shift()) {
      try {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        const page = await fetchPage(l.url);
        if (page.html) {
          const d = parseDetail(page.html);
          out.push({ ...l, detailDescription: d.detailDescription, amenities: d.amenities, dataSource: 'detail' });
          continue;
        }
      } catch {
        // cae a datos de tarjeta
      }
      out.push({ ...l, dataSource: 'card' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker));
  return out;
}

export const argenpropAdapter: PortalAdapter = {
  name: 'argenprop',
  tier: 'scraper',
  async search(criteria): Promise<AdapterResult> {
    const byId = new Map<string, NormalizedListing>();
    let blocked = false;
    let errorCount = 0;
    const targets = buildSearchUrls(criteria);

    for (const { url, barrio } of targets) {
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
        // network error / timeout on one target: keep going with the rest
        errorCount++;
      }
    }

    if (byId.size === 0 && !blocked && errorCount > 0 && errorCount === targets.length)
      return { status: 'error', listings: [], detail: 'all page fetches failed' };
    if (byId.size === 0 && blocked) return { status: 'blocked', listings: [], detail: 'challenge o status de bloqueo' };
    // Devuelve nivel-tarjeta; el detalle (descripción larga + amenities) se enriquece después del
    // gate numérico vía enrich(), para no disparar cientos de fetches sobre el pool paginado entero.
    return { status: 'ok', listings: [...byId.values()] };
  },
  enrich: enrichWithDetail,
};
