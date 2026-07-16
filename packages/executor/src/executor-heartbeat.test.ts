import { describe, expect, it, vi } from 'vitest';
import { startExecutorRuntimeOverseer } from './executor-heartbeat';

describe('startExecutorRuntimeOverseer', () => {
  it('writes immediately and then at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportExecutorTelemetry }) } as any;
      const handle = startExecutorRuntimeOverseer({
        client,
        taskId: 'task-1',
        executorAttemptId: 'attempt-1',
        intervalMs: 1000,
      });

      await Promise.resolve();
      expect(reportExecutorTelemetry).toHaveBeenCalledWith({
        task_id: 'task-1',
        executor_attempt_id: 'attempt-1',
        heartbeat: true,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when disabled', async () => {
    vi.useFakeTimers();
    try {
      const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportExecutorTelemetry }) } as any;
      startExecutorRuntimeOverseer({
        client,
        taskId: 'task-1',
        executorAttemptId: 'attempt-1',
        enabled: false,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(reportExecutorTelemetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the latest pulse before finishing the runtime', async () => {
    const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
    const client = { service: () => ({ reportExecutorTelemetry }) } as any;
    const handle = startExecutorRuntimeOverseer({
      client,
      taskId: 'task-1',
      executorAttemptId: 'attempt-1',
      intervalMs: 60_000,
    });
    await Promise.resolve();

    handle.observe('assistant.stream', 'message-1');
    handle.observe('thinking.progress', 'message-2');
    await handle.finish();

    expect(reportExecutorTelemetry).toHaveBeenLastCalledWith({
      task_id: 'task-1',
      executor_attempt_id: 'attempt-1',
      heartbeat: true,
      pulse: { kind: 'thinking.progress', id: 'message-2' },
    });
  });

  it('abandons the lease immediately when the attempt is rejected', async () => {
    const error = Object.assign(new Error('conflict'), { code: 409 });
    const onLeaseLost = vi.fn();
    const client = {
      service: () => ({ reportExecutorTelemetry: vi.fn().mockRejectedValue(error) }),
    } as any;

    startExecutorRuntimeOverseer({
      client,
      taskId: 'task-1',
      executorAttemptId: 'attempt-1',
      onLeaseLost,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onLeaseLost).toHaveBeenCalledWith(error);
  });

  it('abandons a telemetry request that remains unacknowledged past the lease TTL', async () => {
    vi.useFakeTimers();
    try {
      const onLeaseLost = vi.fn();
      const client = {
        service: () => ({ reportExecutorTelemetry: vi.fn(() => new Promise(() => undefined)) }),
      } as any;

      startExecutorRuntimeOverseer({
        client,
        taskId: 'task-1',
        executorAttemptId: 'attempt-1',
        intervalMs: 1000,
        staleAfterMs: 3000,
        onLeaseLost,
      });
      await vi.advanceTimersByTimeAsync(3000);

      expect(onLeaseLost).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
