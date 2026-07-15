import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_DISPATCH_TIMEOUT_MESSAGE,
  EXECUTOR_HEARTBEAT_LOST_MESSAGE,
  ExecutorHeartbeatSupervisor,
} from './executor-heartbeat-supervisor';

const config = {
  enabled: true,
  interval_ms: 1000,
  stale_after_ms: 3000,
  callback: { command_template: null, timeout_ms: 3000 },
};

describe('ExecutorHeartbeatSupervisor', () => {
  it('marks active tasks failed when latest heartbeat is stale', async () => {
    const staleTask = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      executor_attempt: { id: 'attempt-1' },
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const failForLostHeartbeat = vi.fn().mockResolvedValue({});
    const app = {
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            getOrphaned: vi.fn().mockResolvedValue([staleTask]),
            get: vi.fn().mockResolvedValue(staleTask),
            failForLostHeartbeat,
            finalizeExecutorTurn: vi.fn(),
          };
        }
        throw new Error(`unknown service ${name}`);
      },
    } as any;

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config,
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).toHaveBeenCalledWith(staleTask.task_id, {
      completed_at: '2026-01-01T00:00:05.000Z',
      error_message: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
    });
  });

  it('skips tasks that refreshed before failure', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      executor_attempt: { id: 'attempt-1' },
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    const failForLostHeartbeat = vi.fn();
    const app = {
      service: (name: string) => ({
        getOrphaned: vi.fn().mockResolvedValue([task]),
        get: vi.fn().mockResolvedValue({
          ...task,
          last_executor_heartbeat_at: '2026-01-01T00:00:04.500Z',
        }),
        failForLostHeartbeat: name === 'tasks' ? failForLostHeartbeat : vi.fn(),
      }),
    } as any;

    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config,
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();
    expect(failForLostHeartbeat).not.toHaveBeenCalled();
  });

  it('fails and releases a dispatch that never connected', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000011',
      session_id: '018f0000-0000-7000-8000-000000000012',
      status: 'dispatching',
      started_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      executor_attempt: { id: 'attempt-2' },
    };
    const failForLostHeartbeat = vi.fn().mockResolvedValue({});
    const finalizeExecutorTurn = vi.fn().mockResolvedValue({});
    const app = {
      service: () => ({
        getOrphaned: vi.fn().mockResolvedValue([task]),
        get: vi.fn().mockResolvedValue(task),
        failForLostHeartbeat,
        finalizeExecutorTurn,
      }),
    } as any;
    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config,
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();

    expect(failForLostHeartbeat).toHaveBeenCalledWith(
      task.task_id,
      expect.objectContaining({ error_message: EXECUTOR_DISPATCH_TIMEOUT_MESSAGE })
    );
    expect(finalizeExecutorTurn).toHaveBeenCalledWith({
      task_id: task.task_id,
      executor_attempt_id: 'attempt-2',
    });
  });

  it('settles a stale reserved stop without relabeling it as a failure', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000031',
      session_id: '018f0000-0000-7000-8000-000000000032',
      status: 'stopping',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
      executor_attempt: { id: 'attempt-4' },
    };
    const patch = vi.fn().mockResolvedValue({ ...task, status: 'stopped' });
    const failForLostHeartbeat = vi.fn();
    const finalizeExecutorTurn = vi.fn().mockResolvedValue({});
    const app = {
      service: () => ({
        getOrphaned: vi.fn().mockResolvedValue([task]),
        get: vi.fn().mockResolvedValue(task),
        patch,
        failForLostHeartbeat,
        finalizeExecutorTurn,
      }),
    } as any;
    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config,
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    await supervisor.checkOnce();

    expect(patch).toHaveBeenCalledWith(
      task.task_id,
      expect.objectContaining({ status: 'stopped' }),
      expect.objectContaining({ suppressTerminalQueueProcessing: true })
    );
    expect(failForLostHeartbeat).not.toHaveBeenCalled();
    expect(finalizeExecutorTurn).toHaveBeenCalledWith({
      task_id: task.task_id,
      executor_attempt_id: 'attempt-4',
    });
  });

  it('releases a terminal turn left behind by a daemon restart', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000021',
      session_id: '018f0000-0000-7000-8000-000000000022',
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
      executor_attempt: { id: 'attempt-3' },
    };
    const finalizeExecutorTurn = vi.fn().mockResolvedValue({});
    const app = {
      service: () => ({
        getOrphaned: vi.fn().mockResolvedValue([task]),
        finalizeExecutorTurn,
      }),
    } as any;
    const supervisor = new ExecutorHeartbeatSupervisor({
      app,
      config,
    });

    await supervisor.checkOnce();

    expect(finalizeExecutorTurn).toHaveBeenCalledWith(
      { task_id: task.task_id, executor_attempt_id: 'attempt-3' },
      undefined
    );
  });

  it('does not let one fenced turn starve later retries', async () => {
    const tasks = ['1', '2'].map((suffix) => ({
      task_id: `018f0000-0000-7000-8000-00000000004${suffix}`,
      session_id: `018f0000-0000-7000-8000-00000000005${suffix}`,
      status: 'completed',
      executor_attempt: { id: `attempt-${suffix}` },
    }));
    const finalizeExecutorTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error('cleanup pending'))
      .mockResolvedValueOnce({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const supervisor = new ExecutorHeartbeatSupervisor({
      app: {
        service: () => ({
          getOrphaned: vi.fn().mockResolvedValue(tasks),
          finalizeExecutorTurn,
        }),
      } as any,
      config,
    });

    await supervisor.checkOnce();

    expect(finalizeExecutorTurn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
