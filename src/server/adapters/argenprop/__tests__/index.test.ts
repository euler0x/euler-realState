/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import type { SearchCriteria } from '~/types';
import { argenpropAdapter } from '../index';

const criteria: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo'],
  currency: 'ARS',
  mustHaves: [],
  niceToHaves: [],
  rawDescription: '',
};

describe('argenpropAdapter.search', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns error status when every fetch fails', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    const result = await argenpropAdapter.search(criteria);
    expect(result.status).toBe('error');
    expect(result.listings).toEqual([]);
  });

  it('returns blocked when block status and no listings', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    const result = await argenpropAdapter.search(criteria);
    expect(result.status).toBe('blocked');
  });
});
