import { PROVIDER_RESOLUTION_MODE_ENV_VAR, resolveApiKey } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertProviderAuthenticationBoundary,
  installProviderConnectionSnapshot,
  resolveApiKeyForTask,
} from './base-executor.js';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    resolveApiKey: vi.fn(),
  };
});

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
  beforeEach(() => {
    vi.mocked(resolveApiKey).mockReset();
    delete process.env[PROVIDER_RESOLUTION_MODE_ENV_VAR];
  });

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

    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('keeps local fallback for legacy or unavailable daemon resolution', async () => {
    vi.mocked(resolveApiKey).mockReturnValue({
      apiKey: 'local-key',
      source: 'env',
      useNativeAuth: false,
    });

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(new Error('fetch failed')),
        'task-1' as never,
        'codex' as never
      )
    ).resolves.toMatchObject({ apiKey: 'local-key', source: 'env' });

    expect(resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', { mode: 'static' });
  });

  it('keeps hosted local fallback from enabling shared native authentication', async () => {
    process.env[PROVIDER_RESOLUTION_MODE_ENV_VAR] = 'required_from_auth';
    vi.mocked(resolveApiKey).mockReturnValue({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: false,
    });

    await expect(
      resolveApiKeyForTask(
        'OPENAI_API_KEY',
        makeClient(new Error('fetch failed')),
        'task-1' as never,
        'codex' as never
      )
    ).resolves.toMatchObject({ source: 'none', useNativeAuth: false });

    expect(resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      mode: 'required_from_auth',
    });
  });
});

describe('final provider authentication boundary', () => {
  beforeEach(() => {
    process.env.GH_TOKEN = 'shared-gh-canary';
    process.env.GITHUB_TOKEN = 'shared-github-canary';
    process.env.OPENAI_API_KEY = 'stale-key-canary';
    process.env.OPENAI_BASE_URL = 'https://stale.invalid/v1';
  });

  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  it('replaces inherited aliases with one key and endpoint snapshot', () => {
    installProviderConnectionSnapshot({
      OPENAI_API_KEY: 'task-owner-key',
      OPENAI_BASE_URL: 'https://task-owner.invalid/v1',
    });

    expect(process.env.OPENAI_API_KEY).toBe('task-owner-key');
    expect(process.env.OPENAI_BASE_URL).toBe('https://task-owner.invalid/v1');
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('rejects hosted no-credential resolution before an SDK can discover HOME auth', () => {
    expect(() => assertProviderAuthenticationBoundary('claude-code', {}, false)).toThrow(
      /native authentication is disabled/
    );
    expect(() => assertProviderAuthenticationBoundary('codex', {}, false)).toThrow(
      /native authentication is disabled/
    );
    expect(() => assertProviderAuthenticationBoundary('copilot', {}, false)).toThrow(
      /native authentication is disabled/
    );
  });

  it('allows a scoped Claude subscription token without enabling shared native auth', () => {
    expect(() =>
      assertProviderAuthenticationBoundary(
        'claude-code',
        { CLAUDE_CODE_OAUTH_TOKEN: 'scoped-oauth-canary' },
        false
      )
    ).not.toThrow();
  });
});
