import { describe, expect, it } from 'vitest';
import { getPreviewZScale } from '../src/lib/viewerScaling';

describe('getPreviewZScale', () => {
  it('keeps normal-height models at true scale', () => {
    expect(getPreviewZScale(100, 60)).toBe(1);
    expect(getPreviewZScale(50, 40)).toBe(1);
  });

  it('keeps flat models at true scale too', () => {
    expect(getPreviewZScale(100, 10)).toBe(1);
    expect(getPreviewZScale(100, 1)).toBe(1);
  });
});
