import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeToolTask,
  installProviderConnection,
  resolveApiKeyForTask,
} from './base-executor.js';

function makeClient(error: unknown) {
  return {
    service(name: string) {
      if (name !== 'config/resolve-api-key') {
        throw new Error(`unexpected service ${name}`);
      }
      return {
        create: vi.fn(async () => {
          throw error;
        }),
      };
    },
  } as never;
}

function makeSuccessfulClient(capture: { data?: unknown }) {
  return {
    executorSessionToken: 'executor-jwt',
    service(name: string) {
      if (name !== 'config/resolve-api-key') {
        throw new Error(`unexpected service ${name}`);
      }
      return {
        create: vi.fn(async (data: unknown) => {
          capture.data = data;
          return { apiKey: 'daemon-key', source: 'user', useNativeAuth: false };
        }),
      };
    },
  } as never;
}

describe('resolveApiKeyForTask', () => {
  it('sends the executor session token as explicit task-scoped proof', async () => {
    const capture: { data?: unknown } = {};

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeSuccessfulClient(capture),
        'task-1' as never,
        'codex' as never
      )
    ).resolves.toMatchObject({ apiKey: 'daemon-key', source: 'user' });

    expect(capture.data).toMatchObject({
      taskId: 'task-1',
      keyName: 'OPENAI_API_KEY',
      tool: 'codex',
      executorSessionToken: 'executor-jwt',
    });
  });

  it('does not fall back to local secret resolution after daemon authorization rejection', async () => {
    const forbidden = Object.assign(new Error('Executor token is not valid for this task'), {
      code: 403,
    });

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(forbidden),
        'task-1' as never,
        'codex' as never
      )
    ).rejects.toThrow('Executor token is not valid for this task');
  });

  it('does not consult local config when the daemon is unavailable', async () => {
    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(new Error('fetch failed')),
        'task-1' as never,
        'codex' as never
      )
    ).rejects.toThrow('fetch failed');
  });
});

describe('installProviderConnection', () => {
  // Regression tests for the 2026-07-13 incident: the pre-install strip was
  // tool-agnostic and deleted user-configured env vars (GITHUB_TOKEN in
  // particular) from every session's environment.
  const SEEDED = {
    GITHUB_TOKEN: 'ghp_user',
    MY_CUSTOM_VAR: 'hello',
    ANTHROPIC_API_KEY: 'stale-user-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth',
    AGOR_USER_ENV_KEYS: 'GITHUB_TOKEN,MY_CUSTOM_VAR,ANTHROPIC_API_KEY',
  } as const;

  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, SEEDED);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('replaces the running tool provider surface but keeps user env vars', () => {
    installProviderConnection('claude-code', { ANTHROPIC_API_KEY: 'resolved-key' });

    expect(process.env.ANTHROPIC_API_KEY).toBe('resolved-key');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // stale user value cannot shadow the resolved connection
    expect(process.env.GITHUB_TOKEN).toBe('ghp_user');
    expect(process.env.MY_CUSTOM_VAR).toBe('hello');
  });

  it('leaves other tools user credentials alone for a codex session', () => {
    installProviderConnection('codex', { OPENAI_API_KEY: 'resolved-openai' });

    expect(process.env.OPENAI_API_KEY).toBe('resolved-openai');
    expect(process.env.GITHUB_TOKEN).toBe('ghp_user');
    expect(process.env.ANTHROPIC_API_KEY).toBe('stale-user-key');
  });

  it('still strips ambient GitHub tokens for copilot sessions', () => {
    installProviderConnection('copilot', { COPILOT_GITHUB_TOKEN: 'resolved-copilot' });

    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('resolved-copilot');
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it('rewrites AGOR_USER_ENV_KEYS to only advertise surviving vars', () => {
    installProviderConnection('copilot', { COPILOT_GITHUB_TOKEN: 'resolved-copilot' });

    const advertised = (process.env.AGOR_USER_ENV_KEYS ?? '').split(',');
    expect(advertised).not.toContain('GITHUB_TOKEN');
    expect(advertised).toContain('MY_CUSTOM_VAR');
  });
});

describe('executeToolTask failure finalization', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('leaves failure settlement to the shared executor finish tail', async () => {
    const calls: string[] = [];
    const client = {
      service(name: string) {
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ branch_id: undefined })) };
        }
        if (name === 'config/resolve-api-key') {
          return {
            create: vi.fn(async () => ({ source: 'native', useNativeAuth: true })),
          };
        }
        if (name === 'messages') {
          return {
            find: vi.fn(async () => ({ total: 0, data: [] })),
            create: vi.fn(async () => {
              calls.push('message');
              return {};
            }),
          };
        }
        if (name === 'tasks') {
          return {
            patch: vi.fn(async (_id: string, data: { status?: string }) => {
              if (data.status === 'failed') calls.push('terminal');
              return {};
            }),
          };
        }
        if (name === '/tasks/streaming') return {};
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      executeToolTask({
        client,
        sessionId: '018f0000-0000-7000-8000-000000000001' as never,
        taskId: '018f0000-0000-7000-8000-000000000002' as never,
        prompt: 'fail',
        abortController: new AbortController(),
        apiKeyEnvVar: 'OPENAI_API_KEY',
        toolName: 'codex',
        createTool: () => ({
          executePromptWithStreaming: vi.fn(async () => {
            throw new Error('expected failure');
          }),
        }),
        runtime: {
          observe: vi.fn(),
          finish: vi.fn(async () => calls.push('runtime-finished')),
          stop: vi.fn(),
        },
      })
    ).rejects.toThrow('expected failure');

    expect(calls).toEqual([]);
  });
});
