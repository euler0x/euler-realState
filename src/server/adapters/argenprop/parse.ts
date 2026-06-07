import * as cheerio from 'cheerio';
import type { RawArgenpropListing } from './normalize';

const BASE = 'https://www.argenprop.com';

// Selectores del listado de Argenprop. Si el portal cambia su HTML, ajustar acá
// y re-grabar el fixture (ver __tests__/parse.test.ts).
const SEL = {
  card: 'div.listing__item',
  link: 'a.card',
  title: 'h2.card__title',
  price: 'p.card__price',
  priceExpenses: 'p.card__price span.card__expenses',
  address: 'p.card__address',
  features: 'ul.card__main-features li span',
  description: 'p.card__info',
};

export function parseListings(html: string): RawArgenpropListing[] {
  const $ = cheerio.load(html);
  const out: RawArgenpropListing[] = [];

  $(SEL.card).each((_, el) => {
    const card = $(el);
    const href = card.find(SEL.link).attr('href');
    if (!href) return;

    // Extract price text without the expensas child span, which would
    // otherwise concatenate into the digits (e.g. "648000125000").
    const priceEl = card.find(SEL.price).clone();
    priceEl.find('span.card__expenses').remove();
    const priceText = priceEl.text().trim();

    out.push({
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      title: card.find(SEL.title).text().trim(),
      priceText,
      addressText: card.find(SEL.address).text().trim(),
      featuresText: card
        .find(SEL.features)
        .map((_, li) => $(li).text().trim())
        .get(),
      description: card.find(SEL.description).text().trim(),
    });
  });

  return out;
}
