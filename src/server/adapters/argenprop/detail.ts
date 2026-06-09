import * as cheerio from 'cheerio';

// Argenprop sirve páginas cuyo contenido principal se renderiza con JavaScript (SPA).
// El HTML estático sólo contiene datos estructurados en:
//   1. <script type="application/ld+json">  — descripción completa (preferida)
//   2. <meta property="og:description">     — fallback
//
// Los amenities no están disponibles en el HTML estático; se devuelve [] y el
// orquestador marca la listing como partialData=false sólo si detailDescription está presente.
// Si en el futuro Argenprop vuelve a server-render el HTML, ajustar los selectores de
// SEL_HTML y re-grabar el fixture (ver __tests__/detail.test.ts).

const SEL_HTML = {
  // Selectores de respaldo para páginas con HTML server-rendered
  description: '.section-description--content, .property-description, [class*="description"]',
  amenities: '.property-features li, .features li, [class*="amenities"] li',
};

export interface ParsedDetail {
  detailDescription: string;
  amenities: string[];
}

/** Extrae la descripción completa y la lista de amenities de la página de detalle de Argenprop.
 *
 *  Estrategia:
 *  1. JSON-LD (application/ld+json) → campo `description`
 *  2. og:description meta tag
 *  3. Selectores HTML (fallback para páginas server-rendered)
 *
 *  Si ninguna fuente tiene > 0 chars, devuelve { detailDescription: '', amenities: [] }
 *  sin lanzar excepción.
 */
export function parseDetail(html: string): ParsedDetail {
  // 1. Try JSON-LD first (most reliable for Argenprop SPA pages)
  const jsonLdMatch = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]) as Record<string, unknown>;
      const desc = typeof data['description'] === 'string' ? (data['description'] as string).trim() : '';
      if (desc.length > 0) {
        return { detailDescription: desc, amenities: [] };
      }
    } catch {
      // fall through to next strategy
    }
  }

  // 2. Try og:description meta tag
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  if (ogMatch) {
    const desc = ogMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&#x[\dA-Fa-f]+;/g, (m) => String.fromCharCode(parseInt(m.slice(3, -1), 16)))
      .trim();
    if (desc.length > 0) {
      return { detailDescription: desc, amenities: [] };
    }
  }

  // 3. Fallback: cheerio selectors for server-rendered HTML
  const $ = cheerio.load(html);
  const descHtml = $(SEL_HTML.description).first().text().replace(/\s+/g, ' ').trim();
  const amenities = $(SEL_HTML.amenities)
    .map((_, li) => $(li).text().trim())
    .get()
    .filter(Boolean);

  return { detailDescription: descHtml, amenities };
}
