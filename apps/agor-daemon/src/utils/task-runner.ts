import type { MessageSource, Params } from '@agor/core/types';

/**
 * Normalize a caller-supplied `messageSource` field. Mirrors the gate used
 * by `/sessions/:id/prompt` so the two routes behave identically: invalid
 * values fall back to `'agor'` for socket/REST callers and `undefined` for
 * internal calls.
 */
export function normalizeMessageSource(
  input: MessageSource | undefined,
  params: Params
): MessageSource | undefined {
  if (input !== undefined && input !== 'gateway' && input !== 'agor') {
    return params.provider ? 'agor' : undefined;
  }
  return input;
}
