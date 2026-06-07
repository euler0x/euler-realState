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
    out.push({
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      title: card.find(SEL.title).text().trim(),
      priceText: card.find(SEL.price).text().trim(),
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
