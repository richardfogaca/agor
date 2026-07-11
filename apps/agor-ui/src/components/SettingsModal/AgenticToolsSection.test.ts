import { describe, expect, it } from 'vitest';
import { configuredFieldFromPatchResponse } from './AgenticToolsSection';

describe('configuredFieldFromPatchResponse', () => {
  it('keeps a field configured when clearing the tenant override restores a static fallback', () => {
    expect(
      configuredFieldFromPatchResponse(
        {
          credentials: {
            OPENAI_API_KEY: { configured: true, source: 'config' },
          } as never,
        },
        'OPENAI_API_KEY'
      )
    ).toBe(true);
  });

  it('clears a field when no fallback remains', () => {
    expect(
      configuredFieldFromPatchResponse(
        {
          credentials: {
            OPENAI_API_KEY: { configured: false, source: 'none' },
          } as never,
        },
        'OPENAI_API_KEY'
      )
    ).toBe(false);
  });
});
