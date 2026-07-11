import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getCurrentTenantId,
  ProviderConnectionRepository,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '../db';
import type { Database } from '../db/client';
import { dbTest } from '../db/test-helpers';
import {
  resolveProviderConnection,
  stripProviderCredentialEnvironment,
} from './provider-connection-resolver';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'provider-connection-resolver-test-secret';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

dbTest(
  'selects a user connection atomically instead of mixing its endpoint with a tenant key',
  async ({ db }) => {
    const users = new UsersRepository(db);
    const user = await users.create({ email: 'atomic@example.com', name: 'Atomic' });
    await users.setToolConfigField(
      user.user_id,
      'codex',
      'OPENAI_BASE_URL',
      'https://user.example/v1'
    );
    await new ProviderConnectionRepository(db).setField(
      'codex',
      'OPENAI_API_KEY',
      'tenant-key-must-not-mix'
    );

    const resolved = await resolveProviderConnection('codex', {
      userId: user.user_id,
      db,
      mode: 'required_from_auth',
      config: {},
    });

    expect(resolved).toMatchObject({
      source: 'user',
      useNativeAuth: false,
      connection: { OPENAI_BASE_URL: 'https://user.example/v1' },
    });
    expect(resolved.connection.OPENAI_API_KEY).toBeUndefined();
  }
);

describe('tenant fake-canary isolation', () => {
  it('resolves only the connection visible in the active tenant DB scope', async () => {
    process.env.OPENAI_API_KEY = 'shared-process-canary-must-not-win';
    const db = { run: vi.fn() } as unknown as Database;
    vi.spyOn(ProviderConnectionRepository.prototype, 'find').mockImplementation(async () => {
      const tenant = getCurrentTenantId();
      if (tenant === 'tenant-a') return { OPENAI_API_KEY: 'tenant-a-canary' };
      if (tenant === 'tenant-b') return { OPENAI_API_KEY: 'tenant-b-canary' };
      return null;
    });

    const resolveFor = (tenantId: string) =>
      runWithTenantDatabaseScope(db, tenantId, () =>
        resolveProviderConnection('codex', {
          db,
          mode: 'required_from_auth',
          config: {},
        })
      );

    const tenantA = await resolveFor('tenant-a');
    const tenantB = await resolveFor('tenant-b');

    expect(tenantA.connection.OPENAI_API_KEY).toBe('tenant-a-canary');
    expect(tenantB.connection.OPENAI_API_KEY).toBe('tenant-b-canary');
    expect(JSON.stringify(tenantB)).not.toContain('tenant-a-canary');
    expect(JSON.stringify(tenantB)).not.toContain('shared-process-canary');
  });

  it('fails closed without tenant/user storage even when shared env credentials exist', async () => {
    process.env.OPENAI_API_KEY = 'shared-openai-canary';
    process.env.ANTHROPIC_API_KEY = 'shared-anthropic-canary';

    const resolved = await resolveProviderConnection('codex', {
      mode: 'required_from_auth',
      config: {},
    });

    expect(resolved).toEqual({
      tool: 'codex',
      connection: {},
      source: 'none',
      useNativeAuth: false,
    });
  });

  it('honors an injected hosted mode for a preloaded non-default config', async () => {
    process.env.OPENAI_API_KEY = 'shared-process-canary';
    const resolved = await resolveProviderConnection('codex', {
      mode: 'required_from_auth',
      config: {
        credentials: {
          OPENAI_API_KEY: 'preloaded-yaml-canary',
          OPENAI_BASE_URL: 'https://shared-preloaded.invalid/v1',
        },
      },
    });

    expect(resolved).toEqual({
      tool: 'codex',
      connection: {},
      source: 'none',
      useNativeAuth: false,
    });
  });

  it('keeps explicit static-mode system fallback capability-scoped', async () => {
    process.env.OPENAI_API_KEY = 'static-openai-canary';
    process.env.ANTHROPIC_API_KEY = 'unrelated-anthropic-canary';

    const resolved = await resolveProviderConnection('codex', {
      mode: 'static',
      config: {},
    });

    expect(resolved).toMatchObject({
      source: 'env',
      useNativeAuth: false,
      connection: { OPENAI_API_KEY: 'static-openai-canary' },
    });
    expect(JSON.stringify(resolved)).not.toContain('unrelated-anthropic-canary');
  });
});

it('strips provider secrets from generic child environments', () => {
  expect(
    stripProviderCredentialEnvironment({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'anthropic-canary',
      OPENAI_API_KEY: 'openai-canary',
      GEMINI_API_KEY: 'gemini-canary',
      GOOGLE_API_KEY: 'google-canary',
      GH_TOKEN: 'gh-canary',
      GITHUB_TOKEN: 'github-canary',
    })
  ).toEqual({ PATH: '/bin' });
});
