import type { ResolvedExecutorHeartbeatConfig } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import { isTerminalTaskStatus, type Task, TaskStatus } from '@agor/core/types';
import type { Application, TasksServiceImpl } from '../declarations.js';

export const EXECUTOR_HEARTBEAT_LOST_MESSAGE =
  'Executor heartbeat lost; the executor may have crashed or disconnected.';
export const EXECUTOR_DISPATCH_TIMEOUT_MESSAGE =
  'Executor did not connect before the dispatch deadline.';
const MAX_SUPERVISOR_TICK_MS = 30_000;

function executorLeaseAgeMs(task: Task, nowMs: number): number | undefined {
  const observedAt =
    (isTerminalTaskStatus(task.status) ? task.completed_at : undefined) ??
    task.last_executor_heartbeat_at ??
    task.executor_connected_at ??
    task.started_at ??
    task.created_at;
  const observedMs = new Date(observedAt).getTime();
  return Number.isFinite(observedMs) ? nowMs - observedMs : undefined;
}

export interface ExecutorHeartbeatSupervisorOptions {
  app: Application;
  config: ResolvedExecutorHeartbeatConfig;
  runInTenantScope?: <T>(work: () => Promise<T>) => Promise<T>;
  tickIntervalMs?: number;
  now?: () => Date;
}

export class ExecutorHeartbeatSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;

  constructor(private options: ExecutorHeartbeatSupervisorOptions) {
    this.tickIntervalMs =
      options.tickIntervalMs ?? Math.min(options.config.interval_ms, MAX_SUPERVISOR_TICK_MS);
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.options.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkOnce(): Promise<void> {
    const run = () => this.checkOnceInTenantScope();
    return this.options.runInTenantScope ? this.options.runInTenantScope(run) : run();
  }

  private async checkOnceInTenantScope(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tasksService = this.options.app.service('tasks') as unknown as TasksServiceImpl;
      const tasks = await tasksService.getOrphaned();
      const nowMs = this.now().getTime();
      for (const task of tasks) {
        const attempt = task.executor_attempt;
        if (!attempt || attempt.released_at) continue;
        const ageMs = executorLeaseAgeMs(task, nowMs);
        if (ageMs === undefined || ageMs <= this.options.config.stale_after_ms) continue;

        try {
          const current = await tasksService.get(task.task_id);
          if (
            current.status !== task.status ||
            current.executor_attempt?.id !== attempt.id ||
            current.executor_attempt.released_at
          ) {
            continue;
          }
          const currentAgeMs = executorLeaseAgeMs(current, nowMs);
          if (currentAgeMs === undefined || currentAgeMs <= this.options.config.stale_after_ms) {
            continue;
          }

          if (!isTerminalTaskStatus(current.status)) {
            if (current.status === TaskStatus.STOPPING) {
              await tasksService.patch(task.task_id, {
                status: TaskStatus.STOPPED,
                completed_at: this.now().toISOString(),
              });
            } else {
              await tasksService.patch(task.task_id, {
                status: TaskStatus.FAILED,
                completed_at: this.now().toISOString(),
                error_message:
                  current.status === TaskStatus.DISPATCHING
                    ? EXECUTOR_DISPATCH_TIMEOUT_MESSAGE
                    : EXECUTOR_HEARTBEAT_LOST_MESSAGE,
              });
            }
          }

          // Process exit is the normal finalization signal. This path only
          // recovers attempts whose executor lease went stale.
          await tasksService.finalizeExecutorTurn({
            task_id: task.task_id,
            executor_attempt_id: attempt.id,
          });
          console.warn(
            `[executor-heartbeat] Reconciled stale task ${shortId(task.task_id)} (${currentAgeMs}ms old)`
          );
        } catch (error) {
          console.warn(
            `[executor-heartbeat] Failed to process stale task ${shortId(task.task_id)}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } catch (error) {
      console.warn(
        '[executor-heartbeat] Supervisor check failed:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.running = false;
    }
  }
}
