import { describe, expect, it } from 'vitest';
import { starText } from '../ui';

describe('data-quality stars', () => {
  it('draws 0..5 stars from the server score', () => {
    expect(starText(3)).toBe('★★★☆☆');
    expect(starText(0)).toBe('☆☆☆☆☆');
    expect(starText(9)).toBe('★★★★★');
  });
});
