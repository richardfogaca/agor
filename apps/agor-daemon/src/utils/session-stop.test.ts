import { describe, expect, it, vi } from 'vitest';
import { stopSessionPreserveQueue } from './session-stop.js';

describe('stopSessionPreserveQueue', () => {
  it('stops only the active task and preserves queued tasks until executor release', async () => {
    const sessionId = 'session-1';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      executor_attempt: { id: 'attempt-1' },
    };
    const queuedTask = {
      task_id: 'task-queued',
      session_id: sessionId,
      status: 'queued',
      queue_position: 1,
      created_at: '2026-01-01T00:00:01.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'running',
        ready_for_prompt: false,
        tasks: [runningTask.task_id],
      })),
    };
    const tasksService = {
      reserveExecutorStop: vi.fn(async () => runningTask),
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => [queuedTask]),
    };
    const killExecutorProcess = vi.fn(() => true);
    const params = { provider: 'rest' };

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
        killExecutorProcess,
      },
      sessionId as never,
      params,
      { reason: 'user requested' }
    );

    expect(result).toMatchObject({
      success: true,
      status: 'stopping',
      stoppedTaskId: runningTask.task_id,
      queuedTasksPreserved: 1,
    });
    expect(killExecutorProcess).toHaveBeenCalledWith(sessionId);
    expect(tasksService.patch).toHaveBeenCalledTimes(1);
    expect(tasksService.patch.mock.invocationCallOrder[0]).toBeLessThan(
      killExecutorProcess.mock.invocationCallOrder[0]
    );
    expect(tasksService.patch).toHaveBeenCalledWith(
      runningTask.task_id,
      expect.objectContaining({ status: 'stopped' }),
      expect.objectContaining({
        suppressTerminalQueueProcessing: true,
        suppressCompletionCallbacks: true,
      })
    );
    expect(tasksService.reserveExecutorStop).toHaveBeenCalledWith(sessionId, params);
  });

  it('stops an awaiting_input task when the session is awaiting input', async () => {
    const sessionId = 'session-awaiting-input';
    const awaitingInputTask = {
      task_id: 'task-awaiting-input',
      session_id: sessionId,
      status: 'awaiting_input',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      executor_attempt: { id: 'attempt-2' },
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'awaiting_input',
        ready_for_prompt: false,
        tasks: [awaitingInputTask.task_id],
      })),
    };
    const tasksService = {
      reserveExecutorStop: vi.fn(async () => awaitingInputTask),
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => []),
    };
    const killExecutorProcess = vi.fn(() => true);

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
        killExecutorProcess,
      },
      sessionId as never,
      {},
      { reason: 'user requested' }
    );

    expect(result).toMatchObject({
      success: true,
      status: 'stopping',
      stoppedTaskId: awaitingInputTask.task_id,
      queuedTasksPreserved: 0,
    });
    expect(killExecutorProcess).toHaveBeenCalledWith(sessionId);
    expect(tasksService.patch).toHaveBeenCalledWith(
      awaitingInputTask.task_id,
      expect.objectContaining({ status: 'stopped' }),
      expect.objectContaining({ suppressCompletionCallbacks: true })
    );
  });

  it('does not overwrite a terminal task that is still releasing its executor', async () => {
    const sessionId = 'session-releasing';
    const completedTask = {
      task_id: 'task-completed',
      session_id: sessionId,
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
      executor_attempt: { id: 'attempt-3' },
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'running',
        ready_for_prompt: false,
        tasks: [completedTask.task_id],
      })),
    };
    const tasksService = {
      reserveExecutorStop: vi.fn(async () => completedTask),
      patch: vi.fn(),
    };
    const killExecutorProcess = vi.fn(() => true);

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: { findQueued: vi.fn(async () => []) } as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
        killExecutorProcess,
      },
      sessionId as never
    );

    expect(result.status).toBe('stopping');
    expect(killExecutorProcess).toHaveBeenCalledWith(sessionId);
    expect(tasksService.patch).not.toHaveBeenCalled();
  });

  it('does not stop the task if reserving the stopping state fails', async () => {
    const sessionId = 'session-patch-fails';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    };
    const sessionsService = {
      get: vi.fn(async () => ({
        session_id: sessionId,
        status: 'running',
        ready_for_prompt: false,
        tasks: [runningTask.task_id],
      })),
    };
    const tasksService = {
      reserveExecutorStop: vi.fn(async () => {
        throw new Error('reservation denied');
      }),
      patch: vi.fn(async (id, data) => ({ task_id: id, ...data })),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => []),
    };
    const killExecutorProcess = vi.fn(() => true);

    await expect(
      stopSessionPreserveQueue(
        {
          taskRepo: taskRepo as never,
          sessionsService: sessionsService as never,
          tasksService: tasksService as never,
          killExecutorProcess,
        },
        sessionId as never,
        { provider: 'rest' }
      )
    ).rejects.toThrow('reservation denied');

    expect(tasksService.patch).not.toHaveBeenCalled();
    expect(killExecutorProcess).not.toHaveBeenCalled();
  });

  it('does not signal the executor if persisting the stopped task fails', async () => {
    const sessionId = 'session-task-patch-fails';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const killExecutorProcess = vi.fn(() => true);

    await expect(
      stopSessionPreserveQueue(
        {
          taskRepo: { findQueued: vi.fn(async () => []) } as never,
          sessionsService: {
            get: vi.fn(async () => ({ status: 'running' })),
          } as never,
          tasksService: {
            reserveExecutorStop: vi.fn(async () => runningTask),
            patch: vi.fn(async () => {
              throw new Error('task patch denied');
            }),
          } as never,
          killExecutorProcess,
        },
        sessionId as never
      )
    ).rejects.toThrow('task patch denied');

    expect(killExecutorProcess).not.toHaveBeenCalled();
  });
});
