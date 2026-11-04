/**
 * Terminal sparklines for the live status: one character per sample, eight
 * heights (▁…█). Plain Unicode block characters, so they render over any SSH
 * client without extra fonts.
 */

const BARS = '▁▂▃▄▅▆▇█';

/** Averages consecutive samples so `values` fits in `width` columns (nulls ignored). */
export function resample(values: (number | null)[], width: number): (number | null)[] {
  if (values.length <= width) return values;
  const out: (number | null)[] = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i * values.length) / width);
    const to = Math.floor(((i + 1) * values.length) / width);
    const nums = values.slice(from, to).filter((v): v is number => v !== null);
    out.push(nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
  }
  return out;
}

/** The [min, max] of the non-null values, widened to include `include` (e.g. 0). */
export function extent(values: (number | null)[], include?: number): [number, number] | null {
  const nums = values.filter((v): v is number => v !== null);
  if (include !== undefined) nums.push(include);
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

/**
 * One bar per value, scaled to `[min, max]` (by default the values' own range).
 * Nulls draw as spaces. A flat series draws mid-height. `paint` can colour each
 * bar by its value.
 */
export function sparkline(
  values: (number | null)[],
  width: number,
  range?: [number, number],
  paint?: (bar: string, value: number) => string
): string {
  const vals = resample(values, Math.max(1, width));
  const [min, max] = range ?? extent(vals) ?? [0, 0];
  return vals
    .map((v) => {
      if (v === null) return ' ';
      const level = max > min ? Math.round(((v - min) / (max - min)) * (BARS.length - 1)) : 3;
      const bar = BARS[Math.min(BARS.length - 1, Math.max(0, level))]!;
      return paint ? paint(bar, v) : bar;
    })
    .join('');
}

/* ------------------------------------------------------- multi-row plots */

/** 'unicode' uses block and box-drawing characters; 'ascii' works in any font (PuTTY, mRemoteNG …). */
export type Charset = 'unicode' | 'ascii';

const GLYPHS = {
  unicode: { axis: '┤', corner: '└', rule: '─', zero: '┄', bar: '█', overlap: '◆', spark: BARS },
  ascii: { axis: '|', corner: '+', rule: '-', zero: '-', bar: '#', overlap: '@', spark: '.:-=+*#@' },
};

export interface Series {
  values: (number | null)[];
  /** The character drawn for each point. */
  mark: string;
  paint?: (s: string) => string;
}

const id = (s: string) => s;

/** Y-axis labels on the top, middle and bottom rows; blanks elsewhere. */
function yLabels(height: number, min: number, max: number, fmtY: (v: number) => string, labelWidth: number): string[] {
  return Array.from({ length: height }, (_, row) => {
    const at = height === 1 ? [0] : [0, Math.floor((height - 1) / 2), height - 1];
    if (!at.includes(row)) return ' '.repeat(labelWidth);
    const v = height === 1 ? max : max - (row / (height - 1)) * (max - min);
    return fmtY(v).padStart(labelWidth);
  });
}

/** The time axis under a plot: oldest on the left, "now" on the right. */
function xAxis(width: number, labelWidth: number, leftLabel: string, cs: Charset): string {
  const g = GLYPHS[cs];
  const right = 'now';
  const gap = Math.max(1, width - leftLabel.length - right.length);
  return `${' '.repeat(labelWidth)} ${g.corner}${g.rule.repeat(width)}\n${' '.repeat(labelWidth + 2)}${leftLabel}${' '.repeat(gap)}${right}`;
}

/**
 * Scatter-style line plot of one or more series on a shared scale, `height`
 * rows tall. Where two series land on the same cell the overlap glyph is drawn.
 * Returns the rows top first, with the y axis and the time axis.
 */
export function linePlot(
  series: Series[],
  width: number,
  height: number,
  fmtY: (v: number) => string,
  opts: { charset: Charset; labelWidth: number; leftLabel: string }
): string[] {
  const g = GLYPHS[opts.charset];
  const cols = series.map((s) => resample(s.values, width));
  const range = extent(cols.flat());
  if (!range) return [];
  const [min, max] = range;
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '));
  const owner: number[][] = Array.from({ length: height }, () => Array(width).fill(-1));
  cols.forEach((vals, si) => {
    vals.forEach((v, x) => {
      if (v === null) return;
      const y = max > min ? Math.round(((max - v) / (max - min)) * (height - 1)) : Math.floor(height / 2);
      if (owner[y]![x] !== -1 && owner[y]![x] !== si) grid[y]![x] = g.overlap;
      else grid[y]![x] = (series[si]!.paint ?? id)(series[si]!.mark);
      owner[y]![x] = si;
    });
  });
  const labels = yLabels(height, min, max, fmtY, opts.labelWidth);
  return [...grid.map((r, i) => `${labels[i]} ${g.axis}${r.join('')}`), ...xAxis(width, opts.labelWidth, opts.leftLabel, opts.charset).split('\n')];
}

/**
 * Bars growing up or down from a zero line, `height` rows tall. The range
 * always includes 0, and the y axis labels the top, the zero line and the
 * bottom. Positive bars start on the zero line, so even a tiny one shows;
 * negative bars hang below it and leave the line visible. `paint` colours a
 * bar by its value (e.g. green above 0).
 */
export function barPlot(
  values: (number | null)[],
  width: number,
  height: number,
  fmtY: (v: number) => string,
  opts: { charset: Charset; labelWidth: number; leftLabel: string; paint?: (s: string, v: number) => string }
): string[] {
  const g = GLYPHS[opts.charset];
  const vals = resample(values, width);
  const range = extent(vals, 0);
  if (!range) return [];
  let [min, max] = range;
  if (max === min) [min, max] = [min - 1, max + 1];
  const rowOf = (v: number) => Math.round(((max - v) / (max - min)) * (height - 1));
  const zero = rowOf(0);
  const grid: string[][] = Array.from({ length: height }, (_, y) => Array(width).fill(y === zero ? g.zero : ' '));
  vals.forEach((v, x) => {
    if (v === null) return;
    const y = rowOf(v);
    const [from, to] = v > 0 ? [y, zero] : [zero + 1, y];
    for (let r = from; r <= to; r++) grid[r]![x] = (opts.paint ? (s: string) => opts.paint!(s, v) : id)(g.bar);
  });
  const labels = grid.map((_, row) => {
    const v = row === 0 ? max : row === zero ? 0 : row === height - 1 ? min : null;
    return (v === null ? '' : fmtY(v)).padStart(opts.labelWidth);
  });
  return [...grid.map((r, i) => `${labels[i]} ${g.axis}${r.join('')}`), ...xAxis(width, opts.labelWidth, opts.leftLabel, opts.charset).split('\n')];
}

/** `sparkline` in the given charset. */
export function sparklineIn(cs: Charset, values: (number | null)[], width: number, range?: [number, number], paint?: (bar: string, value: number) => string): string {
  const line = sparkline(values, width, range, paint);
  if (cs === 'unicode') return line;
  return Array.from(line)
    .map((ch) => {
      const i = BARS.indexOf(ch);
      return i === -1 ? ch : GLYPHS.ascii.spark[i]!;
    })
    .join('');
}
