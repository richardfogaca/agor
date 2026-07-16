import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureStopped: vi.fn(),
  stopTemplated: vi.fn(),
  pushSessionState: vi.fn(),
}));

vi.mock('../executor-tracking.js', () => ({
  ensureExecutorWorkloadStopped: mocks.ensureStopped,
  stopTemplatedExecutor: mocks.stopTemplated,
}));
vi.mock('../utils/session-state-hooks.js', () => ({
  pushSessionState: mocks.pushSessionState,
}));

import { createExecutorTurnFinalizer } from './executor-turn-finalizer.js';

function setup(
  statelessFsMode = true,
  workloadKind: 'local' | 'templated' = 'local',
  stopTemplate?: string
) {
  const task = {
    task_id: 'task-1',
    session_id: 'session-1',
    status: 'completed',
    executor_connected_at: '2026-01-01T00:00:00.000Z',
    executor_attempt: { id: 'attempt-1', workload: { kind: workloadKind, pid: 4242 } },
  };
  const releaseExecutorTurn = vi.fn(async () => ({
    ...task,
    executor_attempt: { ...task.executor_attempt, released_at: new Date().toISOString() },
  }));
  const patch = vi.fn(async () => task);
  const services = {
    tasks: { get: vi.fn(async () => task), patch, releaseExecutorTurn },
    sessions: {
      get: vi.fn(async () => ({
        session_id: 'session-1',
        branch_id: 'branch-1',
        sdk_session_id: 'sdk-1',
        agentic_tool: 'claude-code',
      })),
    },
    branches: { get: vi.fn(async () => ({ path: '/tmp/branch' })) },
  };
  const finalizer = createExecutorTurnFinalizer({
    app: { service: (name: keyof typeof services) => services[name] } as never,
    db: {} as never,
    config: {
      execution: {
        stateless_fs_mode: statelessFsMode,
        executor_stop_command_template: stopTemplate,
      },
    },
  });
  return { finalizer, releaseExecutorTurn, patch, services };
}

describe('executor turn finalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureStopped.mockResolvedValue(undefined);
    mocks.stopTemplated.mockResolvedValue(undefined);
    mocks.pushSessionState.mockResolvedValue('session-md5');
  });

  it('passes one ordered cleanup and persistence barrier before release', async () => {
    const { finalizer, releaseExecutorTurn, patch } = setup();

    await finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' });

    expect(mocks.ensureStopped).toHaveBeenCalledWith('attempt-1', {
      kind: 'local',
      pid: 4242,
    });
    expect(mocks.pushSessionState).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('task-1', { session_md5: 'session-md5' }, undefined);
    expect(mocks.ensureStopped.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pushSessionState.mock.invocationCallOrder[0]
    );
    expect(mocks.pushSessionState.mock.invocationCallOrder[0]).toBeLessThan(
      releaseExecutorTurn.mock.invocationCallOrder[0]
    );
  });

  it('does not release when required persistence fails', async () => {
    const { finalizer, releaseExecutorTurn } = setup();
    mocks.pushSessionState.mockRejectedValueOnce(new Error('persistence failed'));

    await expect(
      finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' })
    ).rejects.toThrow('persistence failed');

    expect(releaseExecutorTurn).not.toHaveBeenCalled();
  });

  it('does not release when required session state is missing', async () => {
    const { finalizer, releaseExecutorTurn } = setup();
    mocks.pushSessionState.mockResolvedValueOnce(undefined);

    await expect(
      finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' })
    ).rejects.toThrow('Executor session state could not be persisted');

    expect(releaseExecutorTurn).not.toHaveBeenCalled();
  });

  it('skips persistence when stateless mode is disabled', async () => {
    const { finalizer, releaseExecutorTurn } = setup(false);

    await finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' });

    expect(mocks.ensureStopped).toHaveBeenCalledTimes(1);
    expect(mocks.pushSessionState).not.toHaveBeenCalled();
    expect(releaseExecutorTurn).toHaveBeenCalledTimes(1);
  });

  it('drops external transport authority before background settlement', async () => {
    const { finalizer, services, releaseExecutorTurn } = setup(false);
    const trusted = {
      user: { user_id: 'user-1' },
      tenant: { tenant_id: 'tenant-1', source: 'auth_claim' },
    };

    await finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' }, {
      ...trusted,
      authentication: { strategy: 'jwt' },
      connection: {},
      executorAttemptId: 'attempt-1',
      executorTaskId: 'task-1',
      headers: {},
      provider: 'socketio',
    } as never);

    expect(services.tasks.get).toHaveBeenCalledWith('task-1', trusted);
    expect(releaseExecutorTurn).toHaveBeenCalledWith(
      { task_id: 'task-1', executor_attempt_id: 'attempt-1' },
      trusted
    );
  });

  it('coalesces concurrent finalization of the same attempt', async () => {
    const { finalizer, releaseExecutorTurn } = setup(false);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
    mocks.ensureStopped.mockReturnValueOnce(cleanup);

    const claim = { task_id: 'task-1', executor_attempt_id: 'attempt-1' };
    const first = finalizer(claim);
    const second = finalizer(claim);
    finishCleanup();

    await Promise.all([first, second]);
    expect(mocks.ensureStopped).toHaveBeenCalledTimes(1);
    expect(releaseExecutorTurn).toHaveBeenCalledTimes(1);
  });

  it('requires configured cleanup proof for templated workloads', async () => {
    const { finalizer, releaseExecutorTurn } = setup(false, 'templated');

    await expect(
      finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' })
    ).rejects.toThrow('Templated executor cleanup is not configured');

    expect(releaseExecutorTurn).not.toHaveBeenCalled();
  });

  it('stops a templated workload before local launcher cleanup and release', async () => {
    const { finalizer, releaseExecutorTurn } = setup(
      false,
      'templated',
      'stop {executor_attempt_id} {termination_reason}'
    );

    await finalizer({ task_id: 'task-1', executor_attempt_id: 'attempt-1' });

    expect(mocks.stopTemplated).toHaveBeenCalledWith('stop attempt-1 finalization');
    expect(mocks.stopTemplated.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureStopped.mock.invocationCallOrder[0]
    );
    expect(mocks.ensureStopped.mock.invocationCallOrder[0]).toBeLessThan(
      releaseExecutorTurn.mock.invocationCallOrder[0]
    );
  });
});
