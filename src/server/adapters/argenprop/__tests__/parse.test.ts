/** @jest-environment node */
import { expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseListings } from '../parse';

const html = fs.readFileSync(path.join(__dirname, '../__fixtures__/list-page.html'), 'utf-8');

describe('parseListings (fixture)', () => {
  it('extracts at least 10 listings with url, title and price', () => {
    const raws = parseListings(html);
    expect(raws.length).toBeGreaterThanOrEqual(10);
    for (const r of raws.slice(0, 10)) {
      expect(r.url).toMatch(/^https:\/\/www\.argenprop\.com\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.priceText.length).toBeGreaterThan(0);
    }
  });

  it('returns empty array for non-listing html', () => {
    expect(parseListings('<html><body><h1>hola</h1></body></html>')).toEqual([]);
  });
});
