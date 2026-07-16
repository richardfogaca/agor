import { shortId, type TaskRepository } from '@agor/core/db';
import type { Params, SessionID } from '@agor/core/types';
import { isSessionExecuting, SessionStatus } from '@agor/core/types';
import type { SessionsServiceImpl, TasksServiceImpl } from '../declarations.js';

export interface StopSessionResult {
  success: boolean;
  status?: typeof SessionStatus.IDLE | typeof SessionStatus.STOPPING;
  reason?: string;
  stoppedTaskId?: string;
  queuedTasksPreserved?: number;
}

export interface StopSessionDeps {
  taskRepo: Pick<TaskRepository, 'findQueued'>;
  sessionsService: Pick<SessionsServiceImpl, 'get'>;
  tasksService: Pick<TasksServiceImpl, 'reserveExecutorStop' | 'finalizeExecutorTurn'>;
}

/**
 * Stop semantics, in one place:
 * - target only the active task for the session;
 * - preserve queued work so it can drain after Stop;
 * - treat STOPPED as administrative cancellation, without completion callbacks;
 * - leave executor-backed turns blocked until process exit releases them.
 */
export async function stopSessionPreserveQueue(
  deps: StopSessionDeps,
  sessionId: SessionID,
  params: Params = {},
  options: { reason?: string } = {}
): Promise<StopSessionResult> {
  const session = await deps.sessionsService.get(sessionId, params);

  if (!isSessionExecuting(session)) {
    return {
      success: false,
      reason: `Session cannot be stopped (status: ${session.status})`,
    };
  }

  const queuedTasks = await deps.taskRepo.findQueued(sessionId);
  const latestTask = await deps.tasksService.reserveExecutorStop(sessionId, params);

  if (!latestTask) {
    console.warn(
      `⚠️  [Stop] No active tasks for session ${shortId(sessionId)}, resetting to IDLE${options.reason ? ` (reason: ${options.reason})` : ''}`
    );
    return {
      success: true,
      status: SessionStatus.IDLE,
      reason: 'No active tasks found, session reset to idle',
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  console.log(
    `🛑 [Stop] Stopping task ${shortId(latestTask.task_id)} for session ${shortId(sessionId)}${options.reason ? ` (reason: ${options.reason})` : ''}`
  );
  const internalParams = { ...params, provider: undefined };

  if (latestTask.executor_attempt) {
    try {
      await deps.tasksService.finalizeExecutorTurn(
        {
          task_id: latestTask.task_id,
          executor_attempt_id: latestTask.executor_attempt.id,
        },
        internalParams
      );
    } catch (error) {
      console.warn('[Stop] Cleanup remains fenced for supervisor retry:', error);
    }
  }

  return {
    success: true,
    status: latestTask.executor_attempt ? SessionStatus.STOPPING : SessionStatus.IDLE,
    stoppedTaskId: latestTask.task_id,
    queuedTasksPreserved: queuedTasks.length,
  };
}
