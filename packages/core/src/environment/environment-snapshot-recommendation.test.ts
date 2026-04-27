import { describe, expect, it } from 'vitest';
import type { EnvironmentSnapshotFacts } from '../types/worktree';
import { evaluateEnvironmentSnapshotFacts } from './environment-snapshot-recommendation';

function createFacts(overrides: Partial<EnvironmentSnapshotFacts> = {}): EnvironmentSnapshotFacts {
  return {
    worktree_id: 'wt-1',
    environment_variant: 'dev',
    has_rendered_snapshot: true,
    has_health_check_url: true,
    runtime_status: 'running',
    health_status: 'healthy',
    health_timestamp: '2026-04-26T23:30:00.000Z',
    health_message: 'HTTP 200',
    app_url: 'http://localhost:3001',
    same_worktree: true,
    ...overrides,
  };
}

describe('evaluateEnvironmentSnapshotFacts', () => {
  it('returns reuse only for a rendered snapshot with running healthy runtime evidence', () => {
    const result = evaluateEnvironmentSnapshotFacts(createFacts());

    expect(result.recommendation).toBe('reuse');
    expect(result.reason_codes).toEqual(['eligible_for_reuse']);
    expect(result.summary).toBe(
      'Reuse recommended: rendered snapshot "dev" matches a running environment with healthy live checks.'
    );
  });

  it('returns recommend_fresh with missing_rendered_snapshot when snapshot provenance is absent', () => {
    const result = evaluateEnvironmentSnapshotFacts(createFacts({ has_rendered_snapshot: false }));

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('missing_rendered_snapshot');
    expect(result.summary).toContain(
      'No rendered environment snapshot is recorded for this worktree.'
    );
  });

  it('returns recommend_fresh with missing_runtime_instance when runtime evidence is absent', () => {
    const result = evaluateEnvironmentSnapshotFacts(
      createFacts({
        runtime_status: null,
        health_status: null,
        health_timestamp: null,
        health_message: null,
      })
    );

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toEqual(['missing_runtime_instance', 'health_unknown']);
  });

  it.each([
    'starting',
    'stopped',
    'stopping',
    'error',
  ] as const)('returns runtime_not_running for %s runtime state', (runtimeStatus) => {
    const result = evaluateEnvironmentSnapshotFacts(createFacts({ runtime_status: runtimeStatus }));

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toContain('runtime_not_running');
  });

  it('returns health_unknown when health evidence is missing', () => {
    const result = evaluateEnvironmentSnapshotFacts(
      createFacts({
        health_status: null,
        health_timestamp: null,
        health_message: null,
      })
    );

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toEqual(['health_unknown']);
  });

  it('returns health_unhealthy when the latest health check is unhealthy', () => {
    const result = evaluateEnvironmentSnapshotFacts(
      createFacts({
        health_status: 'unhealthy',
        health_message: 'HTTP 503 Service Unavailable',
      })
    );

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toEqual(['health_unhealthy']);
  });

  it('returns health_check_not_configured when no health check is configured', () => {
    const result = evaluateEnvironmentSnapshotFacts(
      createFacts({
        has_health_check_url: false,
        health_status: 'healthy',
        health_message: 'Process running',
      })
    );

    expect(result.recommendation).toBe('recommend_fresh');
    expect(result.reason_codes).toEqual(['health_check_not_configured']);
  });

  it('returns current_worktree_only before other failures when provenance is not same-worktree', () => {
    const result = evaluateEnvironmentSnapshotFacts(
      createFacts({
        same_worktree: false,
        has_rendered_snapshot: false,
        runtime_status: 'stopped',
        health_status: null,
        health_timestamp: null,
        health_message: null,
      })
    );

    expect(result.reason_codes).toEqual([
      'current_worktree_only',
      'missing_rendered_snapshot',
      'runtime_not_running',
      'health_unknown',
    ]);
  });

  it('returns deterministic safe fields for downstream service and MCP callers', () => {
    const result = evaluateEnvironmentSnapshotFacts(createFacts());

    expect(result).toEqual({
      worktree_id: 'wt-1',
      environment_variant: 'dev',
      environment_status: 'running',
      health_check: {
        status: 'healthy',
        timestamp: '2026-04-26T23:30:00.000Z',
        message: 'HTTP 200',
      },
      app_url: 'http://localhost:3001',
      provenance: {
        same_worktree: true,
        has_rendered_snapshot: true,
        has_runtime_instance: true,
      },
      reason_codes: ['eligible_for_reuse'],
      recommendation: 'reuse',
      summary:
        'Reuse recommended: rendered snapshot "dev" matches a running environment with healthy live checks.',
    });
  });
});
