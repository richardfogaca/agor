import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { ExecutorWorkloadRef } from '@agor/core/types';
import { buildSpawnArgs, getUidFromUsername, isValidUnixUsername } from '@agor/core/unix';

export const EXECUTOR_ATTEMPT_ENV_VAR = 'AGOR_EXECUTOR_ATTEMPT_ID';

const GRACE_MS = 3_000;
const FORCE_MS = 1_000;
const POLL_MS = 50;
const STOP_COMMAND_TIMEOUT_MS = 10_000;
const trackedPids = new Map<string, number>();
const execFileAsync = promisify(execFile);
const CROSS_USER_MARKER_SCAN = [
  'set -eu',
  `marker="${EXECUTOR_ATTEMPT_ENV_VAR}=$1"`,
  '[ "$(id -u)" = "$2" ]',
  'for file in /proc/[0-9]*/environ; do',
  '  if grep -Fzqx -- "$marker" "$file" 2>/dev/null; then',
  `    pid=\${file#/proc/}; printf "%s\\n" "\${pid%/environ}"`,
  '  fi',
  'done',
].join('\n');

interface CrossUserIdentity {
  unixUser: string;
  uid: number;
}

function asUser(command: string, args: string[], unixUser: string) {
  return buildSpawnArgs(command, args, unixUser);
}

export function trackExecutorProcess(attemptId: string, pid: number): void {
  trackedPids.set(attemptId, pid);
}

export async function stopTemplatedExecutor(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      detached: process.platform !== 'win32',
      stdio: 'inherit',
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== 'win32') void signal(-child.pid, 'SIGKILL');
      child.kill('SIGKILL');
      finish(new Error(`Executor cleanup command timed out after ${STOP_COMMAND_TIMEOUT_MS}ms`));
    }, STOP_COMMAND_TIMEOUT_MS);
    child.once('error', finish);
    child.once('exit', (code) =>
      code === 0
        ? finish()
        : finish(new Error(`Executor cleanup command exited with code ${code ?? 'unknown'}`))
    );
  });
}

function crossUserIdentity(workload?: ExecutorWorkloadRef): CrossUserIdentity | undefined {
  if (process.platform !== 'linux' || !workload?.unix_user) return undefined;
  if (
    !isValidUnixUsername(workload.unix_user) ||
    workload.uid === undefined ||
    getUidFromUsername(workload.unix_user) !== workload.uid
  ) {
    throw new Error(`Executor workload owner for PID ${workload.pid} is no longer valid`);
  }
  return workload.uid === process.getuid?.()
    ? undefined
    : { unixUser: workload.unix_user, uid: workload.uid };
}

async function markedPids(attemptId: string, crossUser?: CrossUserIdentity): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  if (crossUser) {
    const command = asUser(
      'bash',
      ['-c', CROSS_USER_MARKER_SCAN, 'agor-executor-cleanup', attemptId, String(crossUser.uid)],
      crossUser.unixUser
    );
    const { stdout } = await execFileAsync(command.cmd, command.args);
    return stdout.split('\n').filter(Boolean).map(Number).filter(Number.isInteger);
  }
  const marker = Buffer.from(`${EXECUTOR_ATTEMPT_ENV_VAR}=${attemptId}\0`);
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          return (await fs.readFile(`/proc/${pid}/environ`)).includes(marker) ? pid : undefined;
        } catch {
          return undefined;
        }
      })
  );
  return matches.filter((pid): pid is number => pid !== undefined);
}

async function descendantPids(...rootPids: number[]): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=']);
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const descendants: number[] = [];
  const pending = rootPids.flatMap((rootPid) => children.get(rootPid) ?? []);
  for (const pid of pending) {
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function signal(
  pid: number,
  value: NodeJS.Signals,
  crossUser?: CrossUserIdentity
): Promise<void> {
  try {
    process.kill(pid, value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' && crossUser) {
      try {
        const command = asUser(
          'kill',
          ['-s', value.slice(3), '--', String(pid)],
          crossUser.unixUser
        );
        await execFileAsync(command.cmd, command.args);
      } catch (signalError) {
        if (isAlive(pid)) throw signalError;
      }
      return;
    }
    if (code !== 'ESRCH' && code !== 'EPERM') {
      console.warn(`[executor-workload] Failed to send ${value} to ${pid}:`, error);
    }
  }
}

async function ownedPids(
  attemptId: string,
  rootPid?: number,
  crossUser?: CrossUserIdentity
): Promise<number[]> {
  const tracked = trackedPids.has(attemptId);
  const roots = rootPid
    ? process.platform === 'win32'
      ? [rootPid]
      : tracked
        ? [rootPid, -rootPid]
        : process.platform === 'linux'
          ? []
          : [-rootPid]
    : [];
  const descendants =
    rootPid &&
    (tracked || (process.platform !== 'linux' && process.platform !== 'win32' && isAlive(-rootPid)))
      ? await descendantPids(rootPid).catch(() => [])
      : [];
  const marked = await markedPids(attemptId, crossUser);
  const markedDescendants = marked.length ? await descendantPids(...marked).catch(() => []) : [];
  return [...new Set([...roots, ...descendants, ...marked, ...markedDescendants])];
}

async function waitUntilStopped(
  attemptId: string,
  rootPid: number | undefined,
  crossUser: CrossUserIdentity | undefined,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await ownedPids(attemptId, rootPid, crossUser)).some(isAlive)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  return !(await ownedPids(attemptId, rootPid, crossUser)).some(isAlive);
}

/** Stop and verify the attempt's process group before its database turn is released. */
export async function ensureExecutorWorkloadStopped(
  attemptId: string,
  workload?: ExecutorWorkloadRef
): Promise<void> {
  const rootPid = trackedPids.get(attemptId) ?? workload?.pid;
  const crossUser = crossUserIdentity(workload);
  const graceful = await ownedPids(attemptId, rootPid, crossUser);
  if (!graceful.some(isAlive)) {
    trackedPids.delete(attemptId);
    return;
  }

  await Promise.all(graceful.map((pid) => signal(pid, 'SIGTERM', crossUser)));
  if (!(await waitUntilStopped(attemptId, rootPid, crossUser, GRACE_MS))) {
    await Promise.all(
      (await ownedPids(attemptId, rootPid, crossUser)).map((pid) =>
        signal(pid, 'SIGKILL', crossUser)
      )
    );
    if (!(await waitUntilStopped(attemptId, rootPid, crossUser, FORCE_MS))) {
      throw new Error(`Executor workload for attempt ${attemptId} is still alive`);
    }
  }
  trackedPids.delete(attemptId);
}
