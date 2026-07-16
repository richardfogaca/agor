import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Params } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
  type ExecutorSessionTokenPayload,
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from './executor-session-token.js';

type Scope = {
  sessionId?: string;
  taskId?: string;
  executorAttemptId?: string;
  branchId?: string;
};

const TASK_LIFECYCLE_FIELDS = new Set([
  'task_id',
  'session_id',
  'created_by',
  'created_at',
  'status',
  'executor_attempt',
  'queue_position',
  'started_at',
  'executor_connected_at',
  'last_executor_heartbeat_at',
  'latest_executor_pulse',
  'completed_at',
  'session_md5',
]);
const DRAFT_TASK_FIELDS = new Set(['session_id', 'status']);
const EXECUTOR_TASK_FIELDS = new Set([
  'status',
  'completed_at',
  'message_range',
  'tool_use_count',
  'git_state',
  'duration_ms',
  'agent_session_id',
  'error_message',
  'model',
  'raw_sdk_response',
  'normalized_sdk_response',
  'computed_context_window',
  'report',
  'permission_request',
]);

function scopedPayload(context: HookContext): ExecutorSessionTokenPayload | null {
  const params = context.params as AuthenticatedParams & ExecutorSessionTokenPayload;
  const payload = params.authentication?.payload as ExecutorSessionTokenPayload | undefined;
  if (payload?.type === EXECUTOR_SESSION_TOKEN_TYPE) {
    if (!isExecutorSessionTokenPayload(payload)) {
      throw new Forbidden('Executor token is not valid for this request');
    }
    return payload;
  }

  // Socket.io can preserve custom auth-result fields (`task_id`, `session_id`)
  // on the connection while dropping the decoded JWT payload. Treat those
  // fields as executor scope only when they came from JWT auth and carry a task
  // claim; normal user/API-key auth must continue through unscoped.
  if (params.authentication?.strategy === 'jwt' && params.task_id) {
    return {
      type: EXECUTOR_SESSION_TOKEN_TYPE,
      purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
      task_id: params.task_id,
      executor_attempt_id: params.executor_attempt_id,
      session_id: params.session_id,
      sessionId: params.sessionId,
      branch_id: params.branch_id,
    };
  }

  if (payload?.type !== undefined) return null;
  return null;
}

function expectClaim(claim: string | undefined, label: string): string {
  if (!claim) {
    throw new Forbidden(`Executor token is missing ${label} scope`);
  }
  return claim;
}

function expectMatch(claim: string, value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (String(value) !== claim) {
    throw new Forbidden(`Executor token ${label} scope does not match this request`);
  }
}

function setIfAbsent(target: Record<string, unknown>, key: string, value: string): void {
  if (target[key] === undefined || target[key] === null) target[key] = value;
}

function normalizePath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function routeId(context: HookContext): string | undefined {
  return (context.params as Params & { route?: { id?: string } }).route?.id;
}

function routeSessionId(context: HookContext): string | undefined {
  return routeId(context) ?? (typeof context.id === 'string' ? context.id : undefined);
}

function recordsFromData(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((item) => {
      const record = asRecord(item);
      if (!record) {
        throw new Forbidden('Executor token requires scoped object payloads');
      }
      return record;
    });
  }
  const record = asRecord(data);
  if (!record) {
    throw new Forbidden('Executor token requires a scoped object payload');
  }
  return [record];
}

function expectExistingMatch(claim: string, value: unknown, label: string): void {
  if (String(value) !== claim) {
    throw new Forbidden(`Executor token ${label} scope does not match this request`);
  }
}

function scopeTaskRecord(record: Record<string, unknown>, scope: Scope): void {
  const taskId = expectClaim(scope.taskId, 'task');
  expectMatch(taskId, record.task_id, 'task');
  setIfAbsent(record, 'task_id', taskId);
  if (scope.sessionId) {
    expectMatch(scope.sessionId, record.session_id, 'session');
    setIfAbsent(record, 'session_id', scope.sessionId);
  }
}

function scopeStreamingEnvelope(data: unknown, scope: Scope): void {
  const envelope = asRecord(data);
  if (!envelope) {
    throw new Forbidden('Executor token requires a scoped streaming payload');
  }
  const eventData = asRecord(envelope.data);
  if (!eventData) {
    throw new Forbidden('Executor token requires scoped streaming event data');
  }
  scopeTaskRecord(eventData, scope);
}

async function loadMessageRecord(
  context: HookContext,
  id: string
): Promise<Record<string, unknown>> {
  const service = context.service as unknown as {
    findByIdForScopeCheck?: (id: string) => Promise<unknown>;
  };
  const record = asRecord(await service.findByIdForScopeCheck?.(id));
  if (!record) {
    throw new Forbidden('Executor token message scope is required for this request');
  }
  return record;
}

function requireMatchingSessionRoute(context: HookContext, scope: Scope): void {
  const sessionId = expectClaim(scope.sessionId, 'session');
  const query = ((context.params as Params).query ?? {}) as Record<string, unknown>;
  const requestedSessionId = routeSessionId(context) ?? query.session_id;
  expectMatch(sessionId, requestedSessionId, 'session');
  if (requestedSessionId === undefined || requestedSessionId === null) {
    throw new Forbidden('Executor token session scope is required for this request');
  }
}

async function requireMessageReadScope(
  context: HookContext,
  id: string,
  scope: Scope
): Promise<void> {
  const existing = await loadMessageRecord(context, id);

  if (scope.sessionId) {
    expectExistingMatch(scope.sessionId, existing.session_id, 'session');
    return;
  }

  const taskId = expectClaim(scope.taskId, 'task');
  expectExistingMatch(taskId, existing.task_id, 'task');
}

type AuthHook = (context: HookContext) => Promise<HookContext>;

export function scopeExecutorRuntimeAuth(requireAuth: AuthHook): AuthHook {
  return async (context: HookContext): Promise<HookContext> => {
    const authenticated = await requireAuth(context);
    return executorRuntimeScopeGuard()(authenticated);
  };
}

/**
 * Restrict executor-session JWTs to the resource claims minted for the
 * executor turn. Normal user/API-key/service auth is intentionally ignored.
 *
 * For list endpoints, this fail-closes by injecting the token scope into the
 * service query. For object mutations, the request must either address the
 * scoped object directly or carry matching parent identifiers.
 */
export function executorRuntimeScopeGuard() {
  return async (context: HookContext): Promise<HookContext> => {
    // Only police calls that arrive over the executor's transport. Internal
    // server-side service composition (provider undefined) is trusted: route
    // handlers the executor legitimately reached fan out to other services
    // (e.g. the session MCP-servers route reads `mcp-servers`) while carrying
    // the executor's auth in `params`. Re-scoping those would reject paths
    // that are intentionally not in this guard's allow-list.
    if (!(context.params as Params).provider) return context;

    const payload = scopedPayload(context);
    const data = (context.data ?? {}) as Record<string, unknown>;
    const path = normalizePath(context.path);

    if (path === 'tasks') {
      const executorMethod =
        context.method === 'connectExecutor' || context.method === 'reportExecutorTelemetry';
      if (executorMethod && !payload) {
        throw new Forbidden('Executor-scoped authentication is required');
      }
      if (context.method === 'create') {
        if (payload) throw new Forbidden('Executors cannot create tasks');
        if (data.status !== undefined && data.status !== TaskStatus.CREATED) {
          throw new Forbidden('External task creation is limited to drafts');
        }
        const forbidden = Object.keys(data).filter(
          (field) => TASK_LIFECYCLE_FIELDS.has(field) && !DRAFT_TASK_FIELDS.has(field)
        );
        if (forbidden.length) {
          throw new Forbidden(`Task lifecycle fields are daemon-owned: ${forbidden.join(', ')}`);
        }
      } else if (context.method === 'patch') {
        const forbidden = Object.keys(data).filter(
          (field) => !payload || !EXECUTOR_TASK_FIELDS.has(field)
        );
        if (forbidden.length) {
          throw new Forbidden(`Task lifecycle fields are daemon-owned: ${forbidden.join(', ')}`);
        }
      } else if (context.method === 'remove') {
        if (payload) throw new Forbidden('Executors cannot remove tasks');
        const existing = asRecord(
          await (
            context.service as { findByIdForScopeCheck?: (id: string) => Promise<unknown> }
          ).findByIdForScopeCheck?.(String(context.id))
        );
        if (
          !existing ||
          (existing.status !== TaskStatus.CREATED && existing.status !== TaskStatus.QUEUED)
        ) {
          throw new Forbidden('Only pending tasks can be removed externally');
        }
      }
    }

    if (!payload) return context;

    const scope = {
      sessionId: getExecutorSessionTokenSessionId(payload),
      taskId: payload.task_id,
      executorAttemptId: payload.executor_attempt_id,
      branchId: payload.branch_id,
    };
    if (scope.executorAttemptId) {
      const params = context.params as Params & {
        executorAttemptId?: string;
        executorTaskId?: string;
      };
      params.executorAttemptId = scope.executorAttemptId;
      params.executorTaskId = scope.taskId;
    }
    const query = ((context.params as Params).query ?? {}) as Record<string, unknown>;
    (context.params as Params).query = query;
    const id = typeof context.id === 'string' ? context.id : undefined;

    if (path === 'sessions') {
      const sessionId = expectClaim(scope.sessionId, 'session');
      if (context.method === 'find') {
        expectMatch(sessionId, query.session_id, 'session');
        setIfAbsent(query, 'session_id', sessionId);
        if (scope.branchId) {
          expectMatch(scope.branchId, query.branch_id, 'branch');
          setIfAbsent(query, 'branch_id', scope.branchId);
        }
      } else {
        if (
          context.method === 'patch' &&
          (data.status === 'running' ||
            data.status === 'awaiting_permission' ||
            data.status === 'awaiting_input')
        ) {
          throw new Forbidden('Executor task state owns session runtime status');
        }
        expectMatch(sessionId, id ?? data.session_id ?? query.session_id, 'session');
        if (!id && data.session_id === undefined && query.session_id === undefined) {
          throw new Forbidden('Executor token session scope is required for this request');
        }
        if (scope.branchId)
          expectMatch(scope.branchId, data.branch_id ?? query.branch_id, 'branch');
      }
    } else if (path === 'tasks') {
      const taskId = expectClaim(scope.taskId, 'task');
      if (context.method === 'find') {
        expectMatch(taskId, query.task_id, 'task');
        setIfAbsent(query, 'task_id', taskId);
        if (scope.sessionId) {
          expectMatch(scope.sessionId, query.session_id, 'session');
          setIfAbsent(query, 'session_id', scope.sessionId);
        }
      } else {
        expectMatch(taskId, id ?? data.task_id ?? query.task_id, 'task');
        if (!id && data.task_id === undefined && query.task_id === undefined) {
          throw new Forbidden('Executor token task scope is required for this request');
        }
        if (scope.sessionId)
          expectMatch(scope.sessionId, data.session_id ?? query.session_id, 'session');
        if (context.method === 'connectExecutor' || context.method === 'reportExecutorTelemetry') {
          expectMatch(
            expectClaim(scope.executorAttemptId, 'attempt'),
            data.executor_attempt_id,
            'attempt'
          );
        }
      }
    } else if (path === 'messages') {
      const taskId = expectClaim(scope.taskId, 'task');
      if (context.method === 'find') {
        const hasTaskQuery = query.task_id !== undefined && query.task_id !== null;
        const hasSessionQuery = query.session_id !== undefined && query.session_id !== null;
        if (hasTaskQuery) {
          expectMatch(taskId, query.task_id, 'task');
          if (scope.sessionId) {
            expectMatch(scope.sessionId, query.session_id, 'session');
            setIfAbsent(query, 'session_id', scope.sessionId);
          }
        } else if (hasSessionQuery) {
          const sessionId = expectClaim(scope.sessionId, 'session');
          expectMatch(sessionId, query.session_id, 'session');
        } else {
          setIfAbsent(query, 'task_id', taskId);
          if (scope.sessionId) {
            setIfAbsent(query, 'session_id', scope.sessionId);
          }
        }
      } else if (context.method === 'create') {
        for (const record of recordsFromData(context.data)) {
          expectMatch(taskId, record.task_id ?? query.task_id, 'task');
          setIfAbsent(record, 'task_id', taskId);
          if (scope.sessionId)
            expectMatch(scope.sessionId, record.session_id ?? query.session_id, 'session');
        }
      } else if (context.method === 'get') {
        if (!id) {
          throw new Forbidden('Executor token message scope is required for this request');
        }
        await requireMessageReadScope(context, id, scope);
      } else if (context.method === 'patch') {
        if (!id) {
          throw new Forbidden('Executor token message scope is required for this request');
        }
        const existing = await loadMessageRecord(context, id);
        expectExistingMatch(taskId, existing.task_id, 'task');
        expectMatch(taskId, data.task_id ?? query.task_id, 'task');
        if (scope.sessionId) {
          expectExistingMatch(scope.sessionId, existing.session_id, 'session');
          expectMatch(scope.sessionId, data.session_id ?? query.session_id, 'session');
        }
      } else {
        throw new Forbidden('Executor token is not valid for this messages request');
      }
    } else if (path === 'branches') {
      const branchId = expectClaim(scope.branchId, 'branch');
      if (context.method === 'find') {
        expectMatch(branchId, query.branch_id, 'branch');
        setIfAbsent(query, 'branch_id', branchId);
      } else {
        expectMatch(branchId, id ?? data.branch_id ?? query.branch_id, 'branch');
        if (!id && data.branch_id === undefined && query.branch_id === undefined) {
          throw new Forbidden('Executor token branch scope is required for this request');
        }
      }
    } else if (path === 'messages/bulk') {
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      for (const record of recordsFromData(context.data)) {
        scopeTaskRecord(record, scope);
      }
    } else if (path === 'messages/streaming' || path === 'tasks/streaming') {
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      scopeStreamingEnvelope(context.data, scope);
    } else if (path === 'sessions/:id/genealogy' || path === 'sessions/genealogy') {
      requireMatchingSessionRoute(context, scope);
    } else if (path === 'sessions/:id/mcp-servers' || path === 'sessions/mcp-servers') {
      if (context.method !== 'find') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      requireMatchingSessionRoute(context, scope);
    } else if (path === 'config/resolve-api-key') {
      if (context.method !== 'create') {
        throw new Forbidden('Executor token is not valid for this endpoint');
      }
      const taskId = expectClaim(scope.taskId, 'task');
      expectMatch(taskId, data.taskId ?? data.task_id, 'task');
      setIfAbsent(data, 'taskId', taskId);
    } else {
      throw new Forbidden('Executor token is not valid for this endpoint');
    }

    return context;
  };
}
