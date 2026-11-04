import { describe, expect, it } from 'vitest';
import { extent, resample, sparkline } from './chart.js';

describe('sparkline', () => {
  it('spans the lowest to the highest bar', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█');
  });

  it('draws gaps as spaces and a flat series at mid height', () => {
    expect(sparkline([1, null, 1], 3)).toBe('▄ ▄');
  });

  it('uses a shared range when given one', () => {
    expect(sparkline([5], 1, [0, 10])).toBe('▅');
  });

  it('squeezes long series into the width by averaging', () => {
    expect(resample([1, 3, 5, 7], 2)).toEqual([2, 6]);
    expect(resample([null, null, 4, 6], 2)).toEqual([null, 5]);
    expect(sparkline(Array.from({ length: 100 }, (_, i) => i), 10)).toHaveLength(10);
  });

  it('extent can force a value such as zero into the range', () => {
    expect(extent([-3, -1], 0)).toEqual([-3, 0]);
    expect(extent([null])).toBeNull();
  });
});
