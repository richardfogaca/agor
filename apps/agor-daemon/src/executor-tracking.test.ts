import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { getUidFromUsername } from '@agor/core/unix';
import { describe, expect, it } from 'vitest';
import {
  captureExecutorProcessIdentity,
  EXECUTOR_ATTEMPT_ENV_VAR,
  ensureExecutorWorkloadStopped,
  stopTemplatedExecutor,
  trackExecutorProcess,
} from './executor-tracking.js';

const CROSS_USER = 'nobody';
const CROSS_USER_UID = getUidFromUsername(CROSS_USER);
const CAN_RUN_CROSS_USER_TEST = (() => {
  if (process.platform !== 'linux' || CROSS_USER_UID === undefined) return false;
  try {
    execFileSync('sudo', ['-n', '-u', CROSS_USER, 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(process.platform === 'win32')('executor workload cleanup', () => {
  it('stops a process tracked by the current daemon', async () => {
    const attemptId = `attempt-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [EXECUTOR_ATTEMPT_ENV_VAR]: attemptId },
    });
    await once(child, 'spawn');
    expect(child.pid).toBeDefined();
    trackExecutorProcess(attemptId, child.pid!);

    try {
      await ensureExecutorWorkloadStopped(attemptId, { kind: 'local', pid: child.pid! });
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already verified gone.
      }
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'recovers a detached attempt from its persisted Linux marker',
    async () => {
      const attemptId = `attempt-recovery-${process.pid}-${Date.now()}`;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [EXECUTOR_ATTEMPT_ENV_VAR]: attemptId },
      });
      await once(child, 'spawn');

      try {
        await ensureExecutorWorkloadStopped(attemptId, { kind: 'local', pid: child.pid! });
        expect(() => process.kill(child.pid!, 0)).toThrow();
      } finally {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already verified gone.
        }
      }
    }
  );

  it.skipIf(process.platform === 'linux')(
    'recovers a persisted process with matching durable identity',
    async () => {
      const attemptId = `persisted-attempt-${process.pid}-${Date.now()}`;
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '--', '--executor-attempt-id', attemptId],
        { detached: true, stdio: 'ignore' }
      );
      await once(child, 'spawn');
      const identity = await captureExecutorProcessIdentity(child.pid!);

      try {
        await ensureExecutorWorkloadStopped(attemptId, {
          kind: 'local',
          pid: child.pid!,
          identity,
        });
        expect(() => process.kill(child.pid!, 0)).toThrow();
      } finally {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already verified gone.
        }
      }
    }
  );

  it.skipIf(process.platform === 'linux')(
    'releases an exited persisted process without signaling a reused PID',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 200)'], {
        detached: true,
        stdio: 'ignore',
      });
      await once(child, 'spawn');
      const identity = await captureExecutorProcessIdentity(child.pid!);
      await once(child, 'exit');

      await expect(
        ensureExecutorWorkloadStopped('exited-attempt', {
          kind: 'local',
          pid: child.pid!,
          identity,
        })
      ).resolves.toBeUndefined();
    }
  );

  it.skipIf(process.platform === 'linux')(
    'fails closed when persisted identity does not match the live process',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      await once(child, 'spawn');
      const identity = await captureExecutorProcessIdentity(child.pid!);

      try {
        await expect(
          ensureExecutorWorkloadStopped('wrong-attempt', {
            kind: 'local',
            pid: child.pid!,
            identity: { ...identity, started_at: 'not-the-same-process' },
          })
        ).rejects.toThrow('no longer matches');
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
      } finally {
        process.kill(-child.pid!, 'SIGKILL');
      }
    }
  );

  it.skipIf(!CAN_RUN_CROSS_USER_TEST)(
    'recovers and verifies a detached attempt owned by another Unix user',
    async () => {
      const attemptId = `attempt-cross-user-${process.pid}-${Date.now()}`;
      const child = spawn(
        'sudo',
        [
          '-n',
          '-u',
          CROSS_USER,
          'env',
          `${EXECUTOR_ATTEMPT_ENV_VAR}=${attemptId}`,
          'sh',
          '-c',
          'echo ready; while :; do sleep 1; done',
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }
      );
      await once(child.stdout!, 'data');
      const exited = once(child, 'exit');

      try {
        await ensureExecutorWorkloadStopped(attemptId, {
          kind: 'local',
          pid: child.pid!,
          unix_user: CROSS_USER,
          uid: CROSS_USER_UID!,
        });
        await exited;
        expect(() => process.kill(child.pid!, 0)).toThrow();
      } finally {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already verified gone.
        }
      }
    }
  );

  it('requires a successful configured cleanup command', async () => {
    await expect(stopTemplatedExecutor('exit 0')).resolves.toBeUndefined();
    await expect(stopTemplatedExecutor('exit 9')).rejects.toThrow();
  });
});
