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
