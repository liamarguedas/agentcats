import { describe, expect, it } from 'vitest';

import { CAT_VARIANTS, fallbackVariant, pickVariant } from './cat-variants.js';

describe('cat variants', () => {
  it('has unique ids for the shipped looks', () => {
    const ids = CAT_VARIANTS.map((v) => v.id);
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('picks a look nobody has yet, then the least used', () => {
    const all = CAT_VARIANTS.map((v) => v.id);
    const [first = '', second = ''] = all;
    expect(pickVariant(all.slice(1), () => 0)).toBe(first);
    expect(pickVariant([...all, first], () => 0)).toBe(second);
  });

  it('derives a stable look for old cats', () => {
    expect(fallbackVariant('abc123')).toBe(fallbackVariant('abc123'));
    expect(CAT_VARIANTS.map((v) => v.id)).toContain(fallbackVariant('abc123'));
  });
});
