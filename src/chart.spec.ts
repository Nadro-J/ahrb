import { describe, expect, it } from 'vitest';
import { barPlot, extent, linePlot, resample, sparkline, sparklineIn } from './chart.js';

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

const ascii = { charset: 'ascii' as const, labelWidth: 4, leftLabel: '-5m' };
const strip = (rows: string[]) => rows.map((r) => r.trimEnd());

describe('linePlot', () => {
  it('draws each series on a shared scale, marking overlaps', () => {
    const rows = linePlot(
      [
        { values: [1, 2, 3], mark: 'o' },
        { values: [3, 2, 1], mark: 'x' },
      ],
      3,
      3,
      (v) => v.toFixed(0),
      ascii
    );
    expect(strip(rows)).toEqual(['   3 |x o', '   2 | @', '   1 |o x', '     +---', '      -5m now']);
  });
});

describe('barPlot', () => {
  it('hangs negative bars below the zero line and stands positive ones on it', () => {
    const rows = barPlot([-2, 0, 2], 3, 5, (v) => v.toFixed(0), ascii);
    expect(strip(rows.slice(0, 5))).toEqual(['   2 |  #', '     |  #', '   0 |--#', '     |#', '  -2 |#']);
  });

  it('draws a threshold line inside the range and leaves out one beyond it', () => {
    const inside = barPlot([-1, 4], 2, 6, (v) => v.toFixed(0), { ...ascii, threshold: { value: 2 } });
    expect(strip(inside.slice(0, 6))).toEqual(['   4 | #', '     | #', '   2 |.#', '     | #', '   0 |-#', '  -1 |#']);
    const beyond = barPlot([-1, -3], 2, 4, (v) => v.toFixed(0), { ...ascii, threshold: { value: 9 } });
    expect(beyond.join('')).not.toContain('.');
  });

  it('labels the zero line even when every value is negative', () => {
    const rows = barPlot([-1, -3], 2, 4, (v) => v.toFixed(0), ascii);
    expect(strip(rows.slice(0, 4))).toEqual(['   0 |--', '     |##', '     | #', '  -3 | #']);
  });
});

describe('sparklineIn', () => {
  it('maps the bars to ASCII', () => {
    expect(sparklineIn('ascii', [1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('.:-=+*#@');
  });
});
