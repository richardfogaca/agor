import type { ExecutorPulseKind, TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export interface ExecutorHeartbeatOptions {
  client: AgorClient;
  taskId: TaskID | string;
  executorAttemptId: string;
  enabled?: boolean;
  intervalMs?: number;
  staleAfterMs?: number;
  onLeaseLost?: (error?: unknown) => void;
  warn?: (...args: unknown[]) => void;
}

export interface ExecutorRuntimeObserver {
  observe(kind: ExecutorPulseKind, id?: string): void;
}

export interface ExecutorRuntime extends ExecutorRuntimeObserver {
  finish(): Promise<void>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 30_000;

export function startExecutorRuntimeOverseer(options: ExecutorHeartbeatOptions): ExecutorRuntime {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return { observe() {}, async finish() {}, stop() {} };
  }

  const intervalMs =
    typeof options.intervalMs === 'number' &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.floor(options.intervalMs)
      : DEFAULT_INTERVAL_MS;
  const warn = options.warn ?? console.warn;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  let stopped = false;
  let leaseLost = false;
  let lastAcknowledgedAt = Date.now();
  let pending: Promise<void> | undefined;
  let pulse: { kind: ExecutorPulseKind; id?: string } | undefined;
  let sentPulse = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  const checkLease = (error?: unknown) => {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? Number((error as { code?: unknown }).code)
        : undefined;
    if (
      !leaseLost &&
      ([401, 403, 409].includes(code ?? 0) || Date.now() - lastAcknowledgedAt >= staleAfterMs)
    ) {
      leaseLost = true;
      stopped = true;
      if (timer) clearInterval(timer);
      options.onLeaseLost?.(error);
    }
  };

  const emit = async () => {
    if (stopped) return;
    if (pending) {
      checkLease();
      await pending;
      const latestKey = pulse ? `${pulse.kind}:${pulse.id ?? ''}` : '';
      if (latestKey && latestKey !== sentPulse) return emit();
      return;
    }
    const snapshot = pulse;
    const pulseKey = snapshot ? `${snapshot.kind}:${snapshot.id ?? ''}` : '';
    pending = options.client
      .service('tasks')
      .reportExecutorTelemetry({
        task_id: options.taskId,
        executor_attempt_id: options.executorAttemptId,
        heartbeat: true,
        ...(snapshot && pulseKey !== sentPulse ? { pulse: snapshot } : {}),
      })
      .then(() => {
        lastAcknowledgedAt = Date.now();
        if (snapshot) sentPulse = pulseKey;
      })
      .catch((error) => {
        warn(
          '[executor-overseer] Failed to report runtime telemetry:',
          error instanceof Error ? error.message : String(error)
        );
        checkLease(error);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  void emit();
  timer = setInterval(() => {
    void emit();
  }, intervalMs);
  timer.unref?.();

  return {
    observe(kind, id) {
      pulse = { kind, ...(id ? { id } : {}) };
    },
    async finish() {
      await emit();
      stopped = true;
      if (timer) clearInterval(timer);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
