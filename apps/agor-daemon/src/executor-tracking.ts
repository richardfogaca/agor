import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

export const EXECUTOR_ATTEMPT_ENV_VAR = 'AGOR_EXECUTOR_ATTEMPT_ID';

const GRACE_MS = 3_000;
const FORCE_MS = 1_000;
const POLL_MS = 50;
const STOP_COMMAND_TIMEOUT_MS = 10_000;
const trackedPids = new Map<string, number>();
const execFileAsync = promisify(execFile);

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
      if (child.pid && process.platform !== 'win32') signal(-child.pid, 'SIGKILL');
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

async function markedPids(attemptId: string): Promise<number[]> {
  if (process.platform !== 'linux') return [];
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

async function descendantPids(rootPid: number): Promise<number[]> {
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
  const pending = [...(children.get(rootPid) ?? [])];
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

function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') {
      console.warn(`[executor-workload] Failed to send ${value} to ${pid}:`, error);
    }
  }
}

async function ownedPids(attemptId: string, rootPid?: number): Promise<number[]> {
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
  return [...new Set([...roots, ...descendants, ...(await markedPids(attemptId))])];
}

async function waitUntilStopped(
  attemptId: string,
  rootPid: number | undefined,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await ownedPids(attemptId, rootPid)).some(isAlive)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  return !(await ownedPids(attemptId, rootPid)).some(isAlive);
}

/** Stop and verify the attempt's process group before its database turn is released. */
export async function ensureExecutorWorkloadStopped(
  attemptId: string,
  persistedPid?: number
): Promise<void> {
  const rootPid = trackedPids.get(attemptId) ?? persistedPid;
  const graceful = await ownedPids(attemptId, rootPid);
  if (!graceful.some(isAlive)) {
    trackedPids.delete(attemptId);
    return;
  }

  for (const pid of graceful) signal(pid, 'SIGTERM');
  if (!(await waitUntilStopped(attemptId, rootPid, GRACE_MS))) {
    for (const pid of await ownedPids(attemptId, rootPid)) signal(pid, 'SIGKILL');
    if (!(await waitUntilStopped(attemptId, rootPid, FORCE_MS))) {
      throw new Error(`Executor workload for attempt ${attemptId} is still alive`);
    }
  }
  trackedPids.delete(attemptId);
}
