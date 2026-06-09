/** @jest-environment node */
import { expect } from '@jest/globals';
import { tokensFromUsage, stableStringify } from '../sdk';

describe('tokensFromUsage', () => {
  it('sums input, output and cache_creation; ignores cache reads', () => {
    expect(
      tokensFromUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 100,
      }),
    ).toBe(6);
    expect(tokensFromUsage({})).toBe(0);
  });
});

describe('stableStringify', () => {
  it('produces byte-identical output regardless of key insertion order', () => {
    const a = stableStringify({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = stableStringify({ a: 2, b: 1, nested: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });
  it('preserves arrays in order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});
