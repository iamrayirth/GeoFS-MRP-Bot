import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../../src/util/duration.js';

describe('duration parsing', () => {
  it.each([
    ['10m', 600_000], ['30m', 1_800_000], ['1h', 3_600_000], ['6h', 21_600_000], ['1d', 86_400_000],
    ['1h30m', 5_400_000], ['90s', 90_000], ['2d12h', 216_000_000], [' 15M ', 900_000], ['1.5h', 5_400_000],
  ])('%s -> %i ms', (input, ms) => expect(parseDuration(input)).toBe(ms));

  it.each(['', 'abc', '10', 'm10', '-5m', '0m', '1x', '10 minutes', '1h-'])('rejects %j', (input) => {
    expect(parseDuration(input)).toBeNull();
  });

  it('formats durations', () => {
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });
});
