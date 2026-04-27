import type { EnvironmentSnapshotResult } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

type ToolConfig = {
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
  inputSchema?: { parse: (value: unknown) => unknown };
  description?: string;
};

type CapturedTool = {
  config: ToolConfig;
  handler: ToolHandler;
};

type ServiceStub = Record<string, (...args: unknown[]) => unknown>;

function makeFakeApp(services: Record<string, ServiceStub>) {
  return {
    service: (name: string) => {
      const svc = services[name];
      if (!svc) {
        throw new Error(`Unexpected service call: ${name}`);
      }
      return svc;
    },
  };
}

async function captureEnvironmentTools(
  services: Record<string, ServiceStub>
): Promise<Record<string, CapturedTool>> {
  const { registerEnvironmentTools } = await import('./environment.js');
  const captured: Record<string, CapturedTool> = {};
  const fakeServer = {
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      captured[name] = { config, handler };
    },
  } as unknown as McpServer;

  registerEnvironmentTools(fakeServer, {
    app: makeFakeApp(services) as any,
    db: {} as any,
    userId: 'user-1' as any,
    sessionId: 'sess-1' as any,
    authenticatedUser: { user_id: 'user-1', role: 'member' } as any,
    baseServiceParams: {
      authenticated: true,
      provider: 'rest',
      user: { user_id: 'user-1', role: 'member' } as any,
    },
  });

  return captured;
}

function makeResult(overrides: Partial<EnvironmentSnapshotResult> = {}): EnvironmentSnapshotResult {
  return {
    worktree_id: 'wt-123',
    environment_variant: 'default',
    environment_status: 'running',
    health_check: {
      status: 'healthy',
      timestamp: '2026-04-26T23:40:00.000Z',
      message: null,
    },
    app_url: 'http://localhost:4173',
    provenance: {
      same_worktree: true,
      has_rendered_snapshot: true,
      has_runtime_instance: true,
    },
    reason_codes: ['eligible_for_reuse'],
    recommendation: 'reuse',
    summary: 'Reuse the current worktree environment.',
    ...overrides,
  };
}

describe('registerEnvironmentTools', () => {
  it('registers agor_environment_snapshot as a read-only tool with worktreeId input', async () => {
    const tools = await captureEnvironmentTools({
      worktrees: {
        getEnvironmentSnapshotRecommendation: async () => makeResult(),
      },
      sessions: {
        get: async () => ({ session_id: 'sess-1', worktree_id: 'wt-123' }),
      },
    });

    const snapshotTool = tools.agor_environment_snapshot;
    expect(snapshotTool).toBeDefined();
    expect(snapshotTool.config.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(snapshotTool.config.description).toMatch(/reuse/i);

    expect(
      snapshotTool.config.inputSchema?.parse({
        worktreeId: 'wt-short',
      })
    ).toEqual({ worktreeId: 'wt-short' });
  });

  it('returns the structured reuse recommendation from the worktrees service', async () => {
    const getEnvironmentSnapshotRecommendation = vi.fn(async () => makeResult());
    const getSession = vi.fn(async () => ({ session_id: 'sess-1', worktree_id: 'wt-123' }));
    const tools = await captureEnvironmentTools({
      worktrees: {
        getEnvironmentSnapshotRecommendation,
      },
      sessions: {
        get: getSession,
      },
    });

    const response = await tools.agor_environment_snapshot.handler({
      worktreeId: 'wt-123',
    });
    const payload = JSON.parse(response.content[0].text) as EnvironmentSnapshotResult;

    expect(getSession).toHaveBeenCalledWith('sess-1', {
      authenticated: true,
      provider: 'rest',
      user: { user_id: 'user-1', role: 'member' },
    });
    expect(getEnvironmentSnapshotRecommendation).toHaveBeenCalledWith(
      'wt-123',
      { currentWorktreeId: 'wt-123' },
      {
        authenticated: true,
        provider: 'rest',
        user: { user_id: 'user-1', role: 'member' },
      }
    );
    expect(payload.recommendation).toBe('reuse');
    expect(payload.reason_codes).toEqual(['eligible_for_reuse']);
    expect(payload.summary).toMatch(/reuse/i);
  });

  it('preserves negative-path recommend_fresh output and does not call lifecycle mutation methods', async () => {
    const getEnvironmentSnapshotRecommendation = vi.fn(async () =>
      makeResult({
        environment_status: 'stopped',
        health_check: {
          status: 'unknown',
          timestamp: null,
          message: null,
        },
        provenance: {
          same_worktree: true,
          has_rendered_snapshot: true,
          has_runtime_instance: false,
        },
        reason_codes: ['missing_runtime_instance'],
        recommendation: 'recommend_fresh',
        summary: 'Recommend a fresh environment because no live runtime evidence exists.',
      })
    );
    const startEnvironment = vi.fn();
    const stopEnvironment = vi.fn();
    const nukeEnvironment = vi.fn();
    const renderEnvironment = vi.fn();
    const checkHealth = vi.fn();
    const getLogs = vi.fn();

    const tools = await captureEnvironmentTools({
      worktrees: {
        getEnvironmentSnapshotRecommendation,
        startEnvironment,
        stopEnvironment,
        nukeEnvironment,
        renderEnvironment,
        checkHealth,
        getLogs,
      },
      sessions: {
        get: async () => ({ session_id: 'sess-1', worktree_id: 'wt-123' }),
      },
    });

    const response = await tools.agor_environment_snapshot.handler({
      worktreeId: 'wt-123',
    });
    const payload = JSON.parse(response.content[0].text) as EnvironmentSnapshotResult;

    expect(payload.recommendation).toBe('recommend_fresh');
    expect(payload.reason_codes).toEqual(['missing_runtime_instance']);
    expect(startEnvironment).not.toHaveBeenCalled();
    expect(stopEnvironment).not.toHaveBeenCalled();
    expect(nukeEnvironment).not.toHaveBeenCalled();
    expect(renderEnvironment).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('serializes only the safe snapshot contract and excludes raw command fields', async () => {
    const tools = await captureEnvironmentTools({
      worktrees: {
        getEnvironmentSnapshotRecommendation: async () => makeResult(),
        get: async () => ({
          worktree_id: 'wt-123',
          start_command: 'pnpm dev',
          stop_command: 'pkill -f pnpm',
          nuke_command: 'docker compose down -v',
          logs_command: 'docker compose logs',
        }),
      },
      sessions: {
        get: async () => ({ session_id: 'sess-1', worktree_id: 'wt-123' }),
      },
    });

    const response = await tools.agor_environment_snapshot.handler({
      worktreeId: 'wt-123',
    });
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;

    expect(payload).not.toHaveProperty('start_command');
    expect(payload).not.toHaveProperty('stop_command');
    expect(payload).not.toHaveProperty('nuke_command');
    expect(payload).not.toHaveProperty('logs_command');
  });

  it('fails closed for cross-worktree requests and threads the caller worktree into the service call', async () => {
    const getEnvironmentSnapshotRecommendation = vi.fn(async () =>
      makeResult({
        worktree_id: 'wt-other',
        provenance: {
          same_worktree: false,
          has_rendered_snapshot: true,
          has_runtime_instance: true,
        },
        reason_codes: ['current_worktree_only'],
        recommendation: 'recommend_fresh',
        summary: 'Fresh environment recommended: Cross-worktree reuse is out of scope in V1.',
      })
    );
    const tools = await captureEnvironmentTools({
      worktrees: {
        getEnvironmentSnapshotRecommendation,
      },
      sessions: {
        get: async () => ({ session_id: 'sess-1', worktree_id: 'wt-123' }),
      },
    });

    const response = await tools.agor_environment_snapshot.handler({
      worktreeId: 'wt-other',
    });
    const payload = JSON.parse(response.content[0].text) as EnvironmentSnapshotResult;

    expect(getEnvironmentSnapshotRecommendation).toHaveBeenCalledWith(
      'wt-other',
      { currentWorktreeId: 'wt-123' },
      {
        authenticated: true,
        provider: 'rest',
        user: { user_id: 'user-1', role: 'member' },
      }
    );
    expect(payload.recommendation).toBe('recommend_fresh');
    expect(payload.reason_codes).toEqual(['current_worktree_only']);
    expect(payload.provenance.same_worktree).toBe(false);
  });

  it('preserves reuse output when the caller requests the current worktree by short ID', async () => {
    const getEnvironmentSnapshotRecommendation = vi.fn(async () =>
      makeResult({
        worktree_id: '019dccd1-c3fd-755f-89c3-d6446a67ea57',
        provenance: {
          same_worktree: true,
          has_rendered_snapshot: true,
          has_runtime_instance: true,
        },
        reason_codes: ['eligible_for_reuse'],
        recommendation: 'reuse',
        summary: 'Reuse recommended for the caller current worktree.',
      })
    );
    const tools = await captureEnvironmentTools({
      worktrees: {
        getEnvironmentSnapshotRecommendation,
      },
      sessions: {
        get: async () => ({
          session_id: 'sess-1',
          worktree_id: '019dccd1-c3fd-755f-89c3-d6446a67ea57',
        }),
      },
    });

    const response = await tools.agor_environment_snapshot.handler({
      worktreeId: '019dccd1',
    });
    const payload = JSON.parse(response.content[0].text) as EnvironmentSnapshotResult;

    expect(getEnvironmentSnapshotRecommendation).toHaveBeenCalledWith(
      '019dccd1',
      { currentWorktreeId: '019dccd1-c3fd-755f-89c3-d6446a67ea57' },
      {
        authenticated: true,
        provider: 'rest',
        user: { user_id: 'user-1', role: 'member' },
      }
    );
    expect(payload.recommendation).toBe('reuse');
    expect(payload.reason_codes).toEqual(['eligible_for_reuse']);
    expect(payload.provenance.same_worktree).toBe(true);
  });
});
