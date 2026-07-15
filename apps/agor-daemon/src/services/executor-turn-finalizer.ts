import type { AgorConfig } from '@agor/core/config';
import { TaskRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { ExecutorClaim, Params, Task } from '@agor/core/types';
import { ExecutorWorkloadKind, isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import {
  getHomedirFromUsername,
  resolveUnixUserForImpersonation,
  type UnixUserMode,
} from '@agor/core/unix';
import type { Application, TasksServiceImpl } from '../declarations.js';
import { ensureExecutorWorkloadStopped, stopTemplatedExecutor } from '../executor-tracking.js';
import { pushSessionState } from '../utils/session-state-hooks.js';
import { substituteTemplateVariables } from '../utils/spawn-executor.js';

export type ExecutorTurnFinalizer = (claim: ExecutorClaim, params?: Params) => Promise<Task>;

const TERMINATION_REASON = {
  FINALIZATION: 'finalization',
  USER_STOP: 'user_stop',
} as const;
const SESSION_STATE_MISSING_ERROR = 'Executor session state could not be persisted';

/** The single cleanup and persistence barrier before an executor turn may release. */
export function createExecutorTurnFinalizer(options: {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
}): ExecutorTurnFinalizer {
  const attemptRepo = new TaskRepository(options.db);
  const active = new Map<string, Promise<Task>>();

  const finalize: ExecutorTurnFinalizer = async (claim, params) => {
    const tasks = options.app.service('tasks') as unknown as TasksServiceImpl;
    const task = await tasks.get(claim.task_id, params);
    const attempt = task.executor_attempt;
    if (attempt?.id !== claim.executor_attempt_id) {
      throw new Error('Executor attempt no longer owns this turn');
    }
    if (attempt.released_at) return task;
    if (!isTerminalTaskStatus(task.status)) throw new Error('Executor turn is not terminal');

    try {
      if (attempt.workload?.kind === ExecutorWorkloadKind.TEMPLATED) {
        const template = options.config.execution?.executor_stop_command_template;
        if (!template) throw new Error('Templated executor cleanup is not configured');
        await stopTemplatedExecutor(
          substituteTemplateVariables(template, {
            task_id: task.task_id,
            session_id: task.session_id,
            executor_attempt_id: attempt.id,
            termination_reason:
              task.status === TaskStatus.STOPPED
                ? TERMINATION_REASON.USER_STOP
                : TERMINATION_REASON.FINALIZATION,
          })
        );
      }
      await ensureExecutorWorkloadStopped(attempt.id, attempt.workload?.pid);

      if (options.config.execution?.stateless_fs_mode && task.executor_connected_at) {
        const session = await options.app.service('sessions').get(task.session_id, params);
        if (session.sdk_session_id) {
          const branch = await options.app.service('branches').get(session.branch_id, params);
          const mode = (options.config.execution.unix_user_mode ?? 'simple') as UnixUserMode;
          const unixUser = resolveUnixUserForImpersonation({
            mode,
            userUnixUsername: session.unix_username,
            executorUnixUser: options.config.execution.executor_unix_user,
          }).unixUser;
          const md5 = await pushSessionState({
            db: options.db,
            sessionId: session.session_id,
            branchId: session.branch_id,
            taskId: task.task_id,
            sdkSessionId: session.sdk_session_id,
            branchPath: branch.path,
            tool: session.agentic_tool,
            lastKnownMd5: task.session_md5,
            executorHomeDir: unixUser ? getHomedirFromUsername(unixUser) : undefined,
          });
          if (!md5) throw new Error(SESSION_STATE_MISSING_ERROR);
          await tasks.patch(task.task_id, { session_md5: md5 }, params);
        }
      }

      return tasks.releaseExecutorTurn(claim, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await attemptRepo
        .patchExecutorAttempt(task.task_id, attempt.id, { finalization_error: message })
        .catch(() => undefined);
      throw error;
    }
  };

  return (claim, params) => {
    const attemptId = claim.executor_attempt_id;
    const existing = active.get(attemptId);
    if (existing) return existing;
    const finalization = finalize(claim, params).finally(() => {
      if (active.get(attemptId) === finalization) active.delete(attemptId);
    });
    active.set(attemptId, finalization);
    return finalization;
  };
}
