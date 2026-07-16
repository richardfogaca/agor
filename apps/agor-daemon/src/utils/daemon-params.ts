import type { Params } from '@agor/core/types';

/** Preserve trusted attribution while dropping request-scoped transport authority. */
export function daemonParams(
  params?: Params & { executorAttemptId?: unknown; executorTaskId?: unknown }
): Params | undefined {
  if (!params) return undefined;
  const {
    authentication: _authentication,
    connection: _connection,
    executorAttemptId: _executorAttemptId,
    executorTaskId: _executorTaskId,
    provider: _provider,
    headers: _headers,
    ...internal
  } = params;
  return internal;
}
