import { describe, expect, it } from 'vitest';
import { normalizeMessageSource } from './task-runner';

describe('normalizeMessageSource', () => {
  it('passes through valid values', () => {
    expect(normalizeMessageSource('agor', { provider: 'rest' })).toBe('agor');
    expect(normalizeMessageSource('gateway', { provider: 'rest' })).toBe('gateway');
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeMessageSource(undefined, { provider: 'rest' })).toBeUndefined();
  });

  it('falls back to "agor" for invalid values from external callers', () => {
    expect(normalizeMessageSource('bogus' as unknown as 'agor', { provider: 'rest' })).toBe('agor');
  });

  it('falls back to undefined for invalid values from internal calls', () => {
    expect(normalizeMessageSource('bogus' as unknown as 'agor', {})).toBeUndefined();
  });
});
