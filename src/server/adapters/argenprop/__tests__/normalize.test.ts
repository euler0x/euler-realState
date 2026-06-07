/** @jest-environment node */
import { expect } from '@jest/globals';
import { normalizeListing, parsePrice, truncateWords } from '../normalize';

describe('parsePrice', () => {
  it('parses ARS prices with thousand dots', () => {
    expect(parsePrice('$ 850.000')).toEqual({ amount: 850_000, currency: 'ARS' });
  });
  it('parses USD prices', () => {
    expect(parsePrice('USD 120.000')).toEqual({ amount: 120_000, currency: 'USD' });
    expect(parsePrice('U$S 95.500')).toEqual({ amount: 95_500, currency: 'USD' });
  });
  it('returns undefined for consultar/empty', () => {
    expect(parsePrice('Consultar precio')).toBeUndefined();
    expect(parsePrice('')).toBeUndefined();
  });
});

describe('truncateWords', () => {
  it('truncates to n words', () => {
    expect(truncateWords('uno dos tres cuatro', 2)).toBe('uno dos…');
    expect(truncateWords('uno dos', 5)).toBe('uno dos');
  });
});

describe('normalizeListing', () => {
  const raw = {
    url: 'https://www.argenprop.com/departamento-en-alquiler--123?utm=x',
    title: 'Depto 2 amb con balcón',
    priceText: '$ 850.000',
    addressText: 'Gorriti 4500, Palermo',
    featuresText: ['2 ambientes', '45 m²', 'balcón'],
    description: 'Hermoso departamento luminoso',
  };

  it('normalizes a raw listing', () => {
    const l = normalizeListing(raw, 'Palermo');
    expect(l).toMatchObject({
      portal: 'argenprop',
      url: 'https://www.argenprop.com/departamento-en-alquiler--123', // query stripped
      title: 'Depto 2 amb con balcón',
      price: { amount: 850_000, currency: 'ARS' },
      barrio: 'Palermo',
      ambientes: 2,
      m2: 45,
    });
    expect(l?.id).toHaveLength(40); // sha1 hex
  });

  it('returns null without price or url', () => {
    expect(normalizeListing({ ...raw, priceText: 'Consultar' }, 'Palermo')).toBeNull();
    expect(normalizeListing({ ...raw, url: '' }, 'Palermo')).toBeNull();
  });
});
