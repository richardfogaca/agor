import { describe, expect, it, vi } from 'vitest';
import { stopSessionPreserveQueue } from './session-stop.js';

describe('stopSessionPreserveQueue', () => {
  it('stops only the active task and preserves queued tasks until executor release', async () => {
    const sessionId = 'session-1';
    const runningTask = {
      task_id: 'task-running',
      session_id: sessionId,
      status: 'stopped',
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
      finalizeExecutorTurn: vi.fn(async () => runningTask),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => [queuedTask]),
    };
    const params = { provider: 'rest' };
    const internalParams = { provider: undefined };

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
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
    expect(tasksService.finalizeExecutorTurn).toHaveBeenCalledWith(
      { task_id: runningTask.task_id, executor_attempt_id: 'attempt-1' },
      internalParams
    );
    expect(tasksService.reserveExecutorStop).toHaveBeenCalledWith(sessionId, params);
  });

  it('stops an awaiting_input task when the session is awaiting input', async () => {
    const sessionId = 'session-awaiting-input';
    const awaitingInputTask = {
      task_id: 'task-awaiting-input',
      session_id: sessionId,
      status: 'stopped',
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
      finalizeExecutorTurn: vi.fn(async () => awaitingInputTask),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => []),
    };

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: taskRepo as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
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
    expect(tasksService.finalizeExecutorTurn).toHaveBeenCalledWith(
      { task_id: awaitingInputTask.task_id, executor_attempt_id: 'attempt-2' },
      { provider: undefined }
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
      finalizeExecutorTurn: vi.fn(async () => completedTask),
    };

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: { findQueued: vi.fn(async () => []) } as never,
        sessionsService: sessionsService as never,
        tasksService: tasksService as never,
      },
      sessionId as never
    );

    expect(result.status).toBe('stopping');
    expect(tasksService.finalizeExecutorTurn).toHaveBeenCalledWith(
      { task_id: completedTask.task_id, executor_attempt_id: 'attempt-3' },
      { provider: undefined }
    );
  });

  it('keeps a stopped turn fenced for supervisor retry when finalization fails', async () => {
    const task = {
      task_id: 'task-fenced',
      session_id: 'session-fenced',
      status: 'running',
      executor_attempt: { id: 'attempt-fenced' },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await stopSessionPreserveQueue(
      {
        taskRepo: { findQueued: vi.fn(async () => []) } as never,
        sessionsService: { get: vi.fn(async () => ({ status: 'running' })) } as never,
        tasksService: {
          reserveExecutorStop: vi.fn(async () => task),
          finalizeExecutorTurn: vi.fn(async () => {
            throw new Error('cleanup pending');
          }),
        } as never,
      },
      task.session_id as never
    );

    expect(result).toMatchObject({ success: true, status: 'stopping' });
    expect(warn).toHaveBeenCalledWith(
      '[Stop] Cleanup remains fenced for supervisor retry:',
      expect.any(Error)
    );
    warn.mockRestore();
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
      finalizeExecutorTurn: vi.fn(),
    };
    const taskRepo = {
      findQueued: vi.fn(async () => []),
    };

    await expect(
      stopSessionPreserveQueue(
        {
          taskRepo: taskRepo as never,
          sessionsService: sessionsService as never,
          tasksService: tasksService as never,
        },
        sessionId as never,
        { provider: 'rest' }
      )
    ).rejects.toThrow('reservation denied');

    expect(tasksService.finalizeExecutorTurn).not.toHaveBeenCalled();
  });
});
