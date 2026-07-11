import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => undefined),
  resolveProviderConnection: vi.fn(),
  resolveProviderCredentialStatus: vi.fn(async () => ({})),
}));

const providerConnectionMocks = vi.hoisted(() => ({
  patch: vi.fn(async () => ({})),
}));

vi.mock('@agor/core/config', () => configMocks);
vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  ProviderConnectionRepository: class {
    patch = providerConnectionMocks.patch;
  },
}));

import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { TaskID, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { ConfigService } from './config.js';

describe('ConfigService.resolveApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveProviderConnection.mockResolvedValue({
      tool: 'codex',
      connection: {
        OPENAI_API_KEY: 'resolved-test-key',
        OPENAI_BASE_URL: 'https://task-owner.invalid/v1',
      },
      source: 'user',
      useNativeAuth: false,
    });
  });

  it('rejects unauthenticated external callers before resolving secrets', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey({ taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY' }, {
        provider: 'rest',
      } as never)
    ).rejects.toBeInstanceOf(NotAuthenticated);

    expect(configMocks.resolveProviderConnection).not.toHaveBeenCalled();
  });

  it('rejects authenticated non-service external callers before resolving secrets', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey({ taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY' }, {
        provider: 'rest',
        user: { user_id: 'user-1' },
      } as never)
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveProviderConnection).not.toHaveBeenCalled();
  });

  it('rejects unsupported key names before resolving secrets', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey({ taskId: 'task-1' as TaskID, keyName: 'UNRELATED_ENV_VAR' }, {
        provider: 'socketio',
        user: { user_id: 'executor-service', _isServiceAccount: true },
      } as never)
    ).rejects.toBeInstanceOf(BadRequest);

    expect(configMocks.resolveProviderConnection).not.toHaveBeenCalled();
  });

  it('allows executor service accounts and resolves for the task creator', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        expect(name).toBe('tasks');
        return {
          get: vi.fn(async () => ({ created_by: 'creator-1' as UserID })),
        };
      },
    } as never;

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        user: { user_id: 'executor-service', _isServiceAccount: true },
      } as never
    );

    expect(result).toEqual({
      apiKey: 'resolved-test-key',
      tool: 'codex',
      connection: {
        OPENAI_API_KEY: 'resolved-test-key',
        OPENAI_BASE_URL: 'https://task-owner.invalid/v1',
      },
      source: 'user',
      useNativeAuth: false,
    });
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledWith('codex', {
      userId: 'creator-1',
      db: {},
      mode: 'static',
      config: {},
    });
  });

  it('uses the queued task owner for one key and endpoint snapshot, not the caller', async () => {
    const preloadedConfig = {
      credentials: { OPENAI_API_KEY: 'shared-static-must-not-win' },
    } as never;
    const service = new ConfigService({} as never, {
      mode: 'required_from_auth',
      config: preloadedConfig,
    });
    service.app = {
      service(name: string) {
        expect(name).toBe('tasks');
        return {
          get: vi.fn(async () => ({
            created_by: 'queued-task-owner' as UserID,
            session_id: 'session-1',
          })),
        };
      },
    } as never;

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        user: { user_id: 'queue-service', _isServiceAccount: true },
      } as never
    );

    expect(result).toMatchObject({
      apiKey: 'resolved-test-key',
      connection: {
        OPENAI_API_KEY: 'resolved-test-key',
        OPENAI_BASE_URL: 'https://task-owner.invalid/v1',
      },
    });
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledTimes(1);
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledWith('codex', {
      userId: 'queued-task-owner',
      db: {},
      mode: 'required_from_auth',
      config: preloadedConfig,
    });
  });

  it('allows task-scoped executor runtime tokens for the matching session tool', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        authentication: {
          payload: { type: 'executor-session', purpose: 'executor-task', task_id: 'task-1' },
        },
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledWith('codex', {
      userId: 'creator-1',
      db: {},
      mode: 'static',
      config: {},
    });
  });

  it('allows executor runtime tokens passed as explicit session-token proof', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      sessionTokenService: {
        validateToken: vi.fn(async () => ({ task_id: 'task-1' })),
      },
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const result = await service.resolveApiKey(
      {
        taskId: 'task-1' as TaskID,
        keyName: 'OPENAI_API_KEY',
        tool: 'codex',
        executorSessionToken: 'executor-jwt',
      },
      {
        provider: 'socketio',
        user: { user_id: 'creator-1' },
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledWith('codex', {
      userId: 'creator-1',
      db: {},
      mode: 'static',
      config: {},
    });
  });

  it('recovers executor runtime scope from the verified access token when payload is absent', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;
    const accessToken = jwt.sign(
      {
        type: 'executor-session',
        purpose: 'executor-task',
        task_id: 'task-1',
      },
      'test-secret'
    );

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        authentication: { accessToken },
        user: { user_id: 'creator-1' },
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledWith('codex', {
      userId: 'creator-1',
      db: {},
      mode: 'static',
      config: {},
    });
  });

  it('allows executor runtime tokens when Socket.io preserved scope fields without payload', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        authentication: { strategy: 'jwt' },
        user: { user_id: 'creator-1' },
        task_id: 'task-1',
        session_id: 'session-1',
        branch_id: 'branch-1',
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveProviderConnection).toHaveBeenCalledWith('codex', {
      userId: 'creator-1',
      db: {},
      mode: 'static',
      config: {},
    });
  });

  it('rejects executor runtime tokens for a different API key than the session tool uses', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return { get: vi.fn(async () => ({ created_by: 'creator-1', session_id: 'session-1' })) };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'ANTHROPIC_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          authentication: {
            payload: { type: 'executor-session', purpose: 'executor-task', task_id: 'task-1' },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveProviderConnection).not.toHaveBeenCalled();
  });

  it('rejects executor runtime tokens for tools without a canonical API key mapping', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return { get: vi.fn(async () => ({ created_by: 'creator-1', session_id: 'session-1' })) };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'opencode' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'opencode' },
        {
          provider: 'socketio',
          authentication: {
            payload: { type: 'executor-session', purpose: 'executor-task', task_id: 'task-1' },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveProviderConnection).not.toHaveBeenCalled();
  });
});

describe('ConfigService.patch onboarding compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockResolvedValue({});
  });

  it('normalizes legacy assistantPending into teammatePending', async () => {
    const service = new ConfigService({} as never);

    const result = await service.patch(null, { onboarding: { assistantPending: true } } as never);

    expect(configMocks.saveConfig).toHaveBeenCalledWith({
      onboarding: { teammatePending: true },
    });
    expect(result.onboarding?.teammatePending).toBe(true);
  });

  it('normalizes legacy persistedAgentPending into teammatePending', async () => {
    const service = new ConfigService({} as never);

    await service.patch(null, { onboarding: { persistedAgentPending: true } } as never);

    expect(configMocks.saveConfig).toHaveBeenCalledWith({
      onboarding: { teammatePending: true },
    });
  });
});

describe('ConfigService tenant provider credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockResolvedValue({});
    configMocks.resolveProviderCredentialStatus.mockResolvedValue({
      OPENAI_API_KEY: { configured: true, source: 'tenant' },
    });
  });

  it('writes credentials only to tenant storage and never mutates YAML or process.env', async () => {
    process.env.OPENAI_API_KEY = 'shared-process-canary';
    const service = new ConfigService({} as never);

    const result = await service.patch(
      null,
      { credentials: { OPENAI_API_KEY: 'tenant-a-canary' } } as never,
      { user: { user_id: 'admin-a' } } as never
    );

    expect(providerConnectionMocks.patch).toHaveBeenCalledWith(
      { codex: { OPENAI_API_KEY: 'tenant-a-canary' } },
      'admin-a'
    );
    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(process.env.OPENAI_API_KEY).toBe('shared-process-canary');
    expect(JSON.stringify(result)).not.toContain('tenant-a-canary');
    delete process.env.OPENAI_API_KEY;
  });

  it('returns the restored static fallback status after clearing a tenant override', async () => {
    configMocks.resolveProviderCredentialStatus.mockResolvedValue({
      OPENAI_API_KEY: { configured: true, source: 'config' },
    });
    const service = new ConfigService({} as never);

    const result = await service.patch(null, {
      credentials: { OPENAI_API_KEY: null },
    } as never);

    expect(providerConnectionMocks.patch).toHaveBeenCalledWith(
      { codex: { OPENAI_API_KEY: null } },
      undefined
    );
    expect(result.credentials.OPENAI_API_KEY).toEqual({ configured: true, source: 'config' });
  });

  it('returns presence/source only and rejects raw config traversal', async () => {
    configMocks.loadConfig.mockResolvedValue({
      credentials: { OPENAI_API_KEY: 'raw-config-canary' },
      database: { postgresql: { password: 'database-password-canary' } },
    });
    const service = new ConfigService({} as never);

    const credentials = await service.get('credentials');
    expect(credentials).toEqual({
      OPENAI_API_KEY: { configured: true, source: 'tenant' },
    });
    expect(JSON.stringify(credentials)).not.toContain('raw-config-canary');
    await expect(service.get('database')).rejects.toBeInstanceOf(BadRequest);
  });

  it('rejects fields outside the tenant provider connection contract', async () => {
    const service = new ConfigService({} as never);
    await expect(
      service.patch(null, {
        credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'user-only-canary' },
      } as never)
    ).rejects.toBeInstanceOf(BadRequest);
    expect(providerConnectionMocks.patch).not.toHaveBeenCalled();
  });

  it('validates the complete request before the repository can partially mutate it', async () => {
    const service = new ConfigService({} as never);
    await expect(
      service.patch(null, {
        credentials: {
          OPENAI_API_KEY: 'would-have-been-partial',
          CLAUDE_CODE_OAUTH_TOKEN: 'invalid-tenant-field',
        },
      } as never)
    ).rejects.toBeInstanceOf(BadRequest);
    expect(providerConnectionMocks.patch).not.toHaveBeenCalled();
  });
});
