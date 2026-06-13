/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';
import { attrNumber, normalizeMeliItem } from '../normalize';
import type { MeliItem } from '../normalize';

function makeItem(overrides?: Partial<MeliItem>): MeliItem {
  return {
    id: '123456789',
    title: 'Departamento en alquiler en Palermo',
    price: 850_000,
    currency_id: 'ARS',
    permalink: 'https://www.mercadolibre.com.ar/MLA-123456789',
    address: {
      neighborhood: 'Palermo',
      city_name: 'Buenos Aires',
      state_name: 'Capital Federal',
    },
    attributes: [
      { id: 'ROOMS', value_name: '3 ambientes', value_struct: { number: 3, unit: 'ambiente' } },
      { id: 'COVERED_AREA', value_name: '75 m²', value_struct: { number: 75, unit: 'm²' } },
      { id: 'MAINTENANCE_FEE', value_name: '$ 45.000', value_struct: { number: 45000, unit: 'ARS' } },
      { id: 'PROPERTY_TYPE', value_name: 'Departamento', value_struct: null },
      { id: 'OPERATION', value_name: 'Alquiler', value_struct: null },
    ],
    ...overrides,
  };
}

describe('attrNumber', () => {
  const attrs = [
    { id: 'ROOMS', value_name: '3 ambientes', value_struct: { number: 3, unit: 'ambiente' } },
    { id: 'BEDROOMS', value_name: '2 dormitorios', value_struct: null },
    { id: 'NULLVAL', value_name: null, value_struct: null },
  ];

  it('prefiere value_struct.number cuando está presente', () => {
    expect(attrNumber(attrs, 'ROOMS')).toBe(3);
  });

  it('parsea el primer número de value_name cuando no hay value_struct', () => {
    expect(attrNumber(attrs, 'BEDROOMS')).toBe(2);
  });

  it('devuelve undefined si el atributo no existe', () => {
    expect(attrNumber(attrs, 'NONEXISTENT')).toBeUndefined();
  });

  it('devuelve undefined si value_name es null', () => {
    expect(attrNumber(attrs, 'NULLVAL')).toBeUndefined();
  });

  it('devuelve undefined si attrs es undefined', () => {
    expect(attrNumber(undefined, 'ROOMS')).toBeUndefined();
  });
});

describe('normalizeMeliItem', () => {
  it('normaliza un item representativo correctamente', () => {
    const item = makeItem();
    const result = normalizeMeliItem(item, 'Palermo fallback');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('meli-123456789');
    expect(result?.portal).toBe('mercadolibre');
    expect(result?.url).toBe('https://www.mercadolibre.com.ar/MLA-123456789');
    expect(result?.title).toBe('Departamento en alquiler en Palermo');
    expect(result?.price).toEqual({ amount: 850_000, currency: 'ARS' });
    expect(result?.ambientes).toBe(3);
    expect(result?.m2).toBe(75);
    expect(result?.expensas).toBe(45000);
    expect(result?.barrio).toBe('Palermo'); // usa neighborhood
    expect(result?.dataSource).toBe('detail');
  });

  it('devuelve null si el item no tiene permalink', () => {
    const item = makeItem({ permalink: '' });
    expect(normalizeMeliItem(item, 'Palermo')).toBeNull();
  });

  it('devuelve null si el price es 0', () => {
    const item = makeItem({ price: 0 });
    expect(normalizeMeliItem(item, 'Palermo')).toBeNull();
  });

  it('devuelve null si el price no es finito (NaN)', () => {
    const item = makeItem({ price: NaN });
    expect(normalizeMeliItem(item, 'Palermo')).toBeNull();
  });

  it('mapea currency USD correctamente', () => {
    const item = makeItem({ price: 120_000, currency_id: 'USD' });
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.price).toEqual({ amount: 120_000, currency: 'USD' });
  });

  it('mapea currency ARS correctamente para currency_id no USD', () => {
    const item = makeItem({ currency_id: 'ARS' });
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.price.currency).toBe('ARS');
  });

  it('deriva ambientes de BEDROOMS+1 cuando no hay ROOMS', () => {
    const item = makeItem({
      attributes: [
        { id: 'BEDROOMS', value_name: '2 dormitorios', value_struct: { number: 2, unit: 'dormitorio' } },
        { id: 'COVERED_AREA', value_name: '60 m²', value_struct: { number: 60, unit: 'm²' } },
      ],
    });
    const result = normalizeMeliItem(item, 'Caballito');
    expect(result?.ambientes).toBe(3); // 2 dormitorios + 1 living
  });

  it('usa TOTAL_AREA cuando no hay COVERED_AREA', () => {
    const item = makeItem({
      attributes: [
        { id: 'ROOMS', value_name: '2', value_struct: { number: 2, unit: 'ambiente' } },
        { id: 'TOTAL_AREA', value_name: '90 m²', value_struct: { number: 90, unit: 'm²' } },
      ],
    });
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.m2).toBe(90);
  });

  it('COVERED_AREA tiene prioridad sobre TOTAL_AREA para m2', () => {
    const item = makeItem({
      attributes: [
        { id: 'COVERED_AREA', value_name: '70 m²', value_struct: { number: 70, unit: 'm²' } },
        { id: 'TOTAL_AREA', value_name: '90 m²', value_struct: { number: 90, unit: 'm²' } },
      ],
    });
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.m2).toBe(70);
  });

  it('usa city_name si neighborhood no está disponible', () => {
    const item = makeItem({
      address: { city_name: 'Buenos Aires', state_name: 'Capital Federal' },
    });
    const result = normalizeMeliItem(item, 'fallback');
    expect(result?.barrio).toBe('Buenos Aires');
  });

  it('usa barrioFallback si no hay address', () => {
    const item = makeItem({ address: undefined });
    const result = normalizeMeliItem(item, 'Fallback Barrio');
    expect(result?.barrio).toBe('Fallback Barrio');
  });

  it('parsea value_name con attrNumber cuando no hay value_struct', () => {
    const item = makeItem({
      attributes: [
        { id: 'ROOMS', value_name: '4 ambientes', value_struct: null },
        { id: 'COVERED_AREA', value_name: '120 m²', value_struct: null },
      ],
    });
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.ambientes).toBe(4);
    expect(result?.m2).toBe(120);
  });

  it('la description incluye el título y los features', () => {
    const item = makeItem();
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.description).toContain(item.title);
    // Debe incluir algún feature de los attributes
    expect(result?.features.length).toBeGreaterThan(0);
  });

  it('ambientes y m2 son undefined cuando no hay attributes relevantes', () => {
    const item = makeItem({
      attributes: [{ id: 'PROPERTY_TYPE', value_name: 'Departamento', value_struct: null }],
    });
    const result = normalizeMeliItem(item, 'Palermo');
    expect(result?.ambientes).toBeUndefined();
    expect(result?.m2).toBeUndefined();
  });
});
