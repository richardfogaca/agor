import type { Application, BoardID, WorktreeID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { WorktreesService } from './worktrees';

function createServiceHarness() {
  const boardObjectsService = {
    find: vi.fn(async () => ({ data: [] })),
    findByWorktreeId: vi.fn(async () => null),
    create: vi.fn(async () => ({ object_id: 'obj-1' })),
    remove: vi.fn(async () => ({})),
  };

  const sessionsService = {
    find: vi.fn(async () => []),
    patch: vi.fn(async () => ({})),
  };

  const reposService = {
    get: vi.fn(async () => ({ repo_id: 'repo-1', local_path: '/tmp/repo', unix_group: null })),
  };

  const app = {
    service(path: string) {
      if (path === 'board-objects') return boardObjectsService;
      if (path === 'sessions') return sessionsService;
      if (path === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
      if (path === 'worktrees') return { find: vi.fn(async () => []) };
      if (path === 'repos') return reposService;
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;

  const service = new WorktreesService({} as never, app);
  return { service, boardObjectsService, sessionsService };
}

describe('WorktreesService.unarchive', () => {
  it('preserves existing board_id when options.boardId is not provided', async () => {
    const { service, boardObjectsService, sessionsService } = createServiceHarness();
    const worktreeId = 'wt-1' as WorktreeID;
    const existingBoardId = 'board-a' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 1',
      path: '/tmp',
      archived: true,
      board_id: existingBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 1',
      path: '/tmp',
      archived: false,
      board_id: existingBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForWorktree').mockResolvedValue({
      x: 111,
      y: 222,
    });

    await service.unarchive(worktreeId);

    expect(patchSpy).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({
        archived: false,
        archived_at: undefined,
        archived_by: undefined,
        filesystem_status: undefined,
      }),
      undefined
    );
    expect(patchSpy.mock.calls[0][1]).not.toHaveProperty('board_id');

    expect(boardObjectsService.findByWorktreeId).toHaveBeenCalledWith(worktreeId);
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: existingBoardId,
      worktree_id: worktreeId,
      position: { x: 111, y: 222 },
    });

    expect(sessionsService.find).toHaveBeenCalledTimes(1);
    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it('does not create a new board object when one already exists', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const worktreeId = 'wt-2' as WorktreeID;
    const boardId = 'board-b' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 2',
      path: '/tmp',
      archived: true,
      board_id: boardId,
    } as never);
    vi.spyOn(service, 'patch').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 2',
      path: '/tmp',
      archived: false,
      board_id: boardId,
    } as never);
    boardObjectsService.findByWorktreeId.mockResolvedValue({ object_id: 'existing' });

    await service.unarchive(worktreeId);

    expect(boardObjectsService.findByWorktreeId).toHaveBeenCalledWith(worktreeId);
    expect(boardObjectsService.create).not.toHaveBeenCalled();
  });

  it('uses explicit options.boardId override for patch and placement', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const worktreeId = 'wt-3' as WorktreeID;
    const oldBoardId = 'board-old' as BoardID;
    const newBoardId = 'board-new' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 3',
      path: '/tmp',
      archived: true,
      board_id: oldBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      worktree_id: worktreeId,
      name: 'WT 3',
      path: '/tmp',
      archived: false,
      board_id: newBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForWorktree').mockResolvedValue({
      x: 7,
      y: 8,
    });

    await service.unarchive(worktreeId, { boardId: newBoardId });

    expect(patchSpy).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({
        archived: false,
        board_id: newBoardId,
      }),
      undefined
    );
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: newBoardId,
      worktree_id: worktreeId,
      position: { x: 7, y: 8 },
    });
  });
});

describe('WorktreesService.getEnvironmentSnapshotRecommendation', () => {
  it('returns reuse for a same-worktree rendered snapshot with a healthy running environment', async () => {
    const { service } = createServiceHarness();
    const worktreeId = 'wt-env-1' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'unknown',
          timestamp: '2026-04-26T23:20:00Z',
          message: 'stale',
        },
      },
    } as never);
    const checkHealthSpy = vi.spyOn(service, 'checkHealth').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'healthy',
          timestamp: '2026-04-26T23:21:00Z',
          message: 'HTTP 200',
        },
      },
    } as never);

    const result = await service.getEnvironmentSnapshotRecommendation(worktreeId);

    expect(checkHealthSpy).toHaveBeenCalledWith(worktreeId, undefined);
    expect(result).toEqual({
      worktree_id: worktreeId,
      environment_variant: 'web',
      environment_status: 'running',
      health_check: {
        status: 'healthy',
        timestamp: '2026-04-26T23:21:00Z',
        message: 'HTTP 200',
      },
      app_url: 'http://localhost:3000',
      provenance: {
        same_worktree: true,
        has_rendered_snapshot: true,
        has_runtime_instance: true,
      },
      reason_codes: ['eligible_for_reuse'],
      recommendation: 'reuse',
      summary:
        'Reuse recommended: rendered snapshot "web" matches a running environment with healthy live checks.',
    });
  });

  it('returns recommend_fresh when no rendered snapshot provenance exists', async () => {
    const { service } = createServiceHarness();
    const worktreeId = 'wt-env-missing-snapshot' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
      },
    } as never);
    vi.spyOn(service, 'checkHealth').mockResolvedValue({
      worktree_id: worktreeId,
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'healthy',
          timestamp: '2026-04-26T23:21:00Z',
          message: 'HTTP 200',
        },
      },
    } as never);

    const result = await service.getEnvironmentSnapshotRecommendation(worktreeId);

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('missing_rendered_snapshot');
  });

  it('returns recommend_fresh when no runtime instance exists', async () => {
    const { service } = createServiceHarness();
    const worktreeId = 'wt-env-missing-runtime' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
    } as never);
    const checkHealthSpy = vi.spyOn(service, 'checkHealth');

    const result = await service.getEnvironmentSnapshotRecommendation(worktreeId);

    expect(checkHealthSpy).not.toHaveBeenCalled();
    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('missing_runtime_instance');
  });

  it('returns recommend_fresh for a starting runtime after reusing the active health refresh path', async () => {
    const { service } = createServiceHarness();
    const worktreeId = 'wt-env-starting' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'starting',
      },
    } as never);
    const checkHealthSpy = vi.spyOn(service, 'checkHealth').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'starting',
        last_health_check: {
          status: 'unknown',
          timestamp: '2026-04-26T23:23:00Z',
          message: 'starting',
        },
      },
    } as never);

    const result = await service.getEnvironmentSnapshotRecommendation(worktreeId);

    expect(checkHealthSpy).toHaveBeenCalledWith(worktreeId, undefined);
    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('runtime_not_running');
  });

  it.each([
    'stopping',
    'stopped',
    'error',
  ] as const)('returns recommend_fresh without refreshing health when runtime status is %s', async (runtimeStatus) => {
    const { service } = createServiceHarness();
    const worktreeId = 'wt-env-2' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: runtimeStatus,
        last_health_check: {
          status: 'healthy',
          timestamp: '2026-04-26T23:20:00Z',
          message: 'HTTP 200',
        },
      },
    } as never);
    const checkHealthSpy = vi.spyOn(service, 'checkHealth');

    const result = await service.getEnvironmentSnapshotRecommendation(worktreeId);

    expect(checkHealthSpy).not.toHaveBeenCalled();
    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('runtime_not_running');
    expect(result.health_check.status).toBe('healthy');
  });

  it('fails closed when no health check is configured and omits raw command fields', async () => {
    const { service } = createServiceHarness();
    const worktreeId = 'wt-env-3' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      start_command: 'SECRET=1 pnpm dev',
      stop_command: 'docker compose down',
      logs_command: 'docker compose logs',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
      },
    } as never);
    vi.spyOn(service, 'checkHealth').mockResolvedValue({
      worktree_id: worktreeId,
      environment_variant: 'web',
      start_command: 'SECRET=1 pnpm dev',
      stop_command: 'docker compose down',
      logs_command: 'docker compose logs',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'healthy',
          timestamp: '2026-04-26T23:22:00Z',
          message: 'Process running',
        },
      },
    } as never);

    const result = await service.getEnvironmentSnapshotRecommendation(worktreeId);

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('health_check_not_configured');
    expect(result.health_check).toEqual({
      status: 'healthy',
      timestamp: '2026-04-26T23:22:00Z',
      message: 'Process running',
    });
    expect(result).not.toHaveProperty('start_command');
    expect(result).not.toHaveProperty('stop_command');
    expect(result).not.toHaveProperty('logs_command');
  });

  it('fails closed for cross-worktree requests without refreshing health', async () => {
    const { service } = createServiceHarness();
    const requestedWorktreeId = 'wt-env-other' as WorktreeID;
    const currentWorktreeId = 'wt-env-current' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: requestedWorktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'healthy',
          timestamp: '2026-04-26T23:24:00Z',
          message: 'HTTP 200',
        },
      },
    } as never);
    const checkHealthSpy = vi.spyOn(service, 'checkHealth');

    const result = await service.getEnvironmentSnapshotRecommendation(requestedWorktreeId, {
      currentWorktreeId,
    });

    expect(checkHealthSpy).not.toHaveBeenCalled();
    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toEqual(['current_worktree_only']);
    expect(result.provenance.same_worktree).toBe(false);
    expect(result.worktree_id).toBe(requestedWorktreeId);
  });

  it('treats the caller short ID as same-worktree after canonical resolution', async () => {
    const { service } = createServiceHarness();
    const requestedShortId = 'wt-env' as WorktreeID;
    const canonicalWorktreeId = '019dccd1-c3fd-755f-89c3-d6446a67ea57' as WorktreeID;

    vi.spyOn(service, 'get').mockResolvedValue({
      worktree_id: canonicalWorktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'unknown',
          timestamp: '2026-04-26T23:24:00Z',
          message: 'stale',
        },
      },
    } as never);
    const checkHealthSpy = vi.spyOn(service, 'checkHealth').mockResolvedValue({
      worktree_id: canonicalWorktreeId,
      environment_variant: 'web',
      health_check_url: 'http://localhost:3000/health',
      app_url: 'http://localhost:3000',
      environment_instance: {
        status: 'running',
        last_health_check: {
          status: 'healthy',
          timestamp: '2026-04-26T23:25:00Z',
          message: 'HTTP 200',
        },
      },
    } as never);

    const result = await service.getEnvironmentSnapshotRecommendation(requestedShortId, {
      currentWorktreeId: canonicalWorktreeId,
    });

    expect(checkHealthSpy).toHaveBeenCalledWith(requestedShortId, undefined);
    expect(result.recommendation).toBe('reuse');
    expect(result.reason_codes).toEqual(['eligible_for_reuse']);
    expect(result.provenance.same_worktree).toBe(true);
    expect(result.worktree_id).toBe(canonicalWorktreeId);
  });
});
