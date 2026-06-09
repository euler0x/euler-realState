/** @jest-environment node */
import { expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseDetail } from '../detail';

const html = fs.readFileSync(path.join(__dirname, '../__fixtures__/detail-page.html'), 'utf-8');

describe('parseDetail (fixture)', () => {
  it('extracts a long description and an amenities list', () => {
    const d = parseDetail(html);
    expect(d.detailDescription.length).toBeGreaterThan(100);
    expect(Array.isArray(d.amenities)).toBe(true);
  });
  it('returns empty fields for non-detail html without throwing', () => {
    const d = parseDetail('<html><body><h1>nada</h1></body></html>');
    expect(d.detailDescription).toBe('');
    expect(d.amenities).toEqual([]);
  });
});
