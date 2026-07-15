import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_ATTEMPT_ENV_VAR,
  ensureExecutorWorkloadStopped,
  stopTemplatedExecutor,
} from './executor-tracking.js';

describe.skipIf(process.platform === 'win32')('executor workload cleanup', () => {
  it('recovers and verifies a detached attempt from its persisted identity', async () => {
    const attemptId = `attempt-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [EXECUTOR_ATTEMPT_ENV_VAR]: attemptId },
    });
    await once(child, 'spawn');
    expect(child.pid).toBeDefined();

    try {
      await ensureExecutorWorkloadStopped(attemptId, child.pid);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already verified gone.
      }
    }
  });

  it('requires a successful configured cleanup command', async () => {
    await expect(stopTemplatedExecutor('exit 0')).resolves.toBeUndefined();
    await expect(stopTemplatedExecutor('exit 9')).rejects.toThrow();
  });
});
