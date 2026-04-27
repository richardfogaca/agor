import type {
  EnvironmentSnapshotFacts,
  EnvironmentSnapshotReasonCode,
  EnvironmentSnapshotResult,
} from '../types/worktree';

const FAILURE_REASON_ORDER: EnvironmentSnapshotReasonCode[] = [
  'current_worktree_only',
  'missing_rendered_snapshot',
  'missing_runtime_instance',
  'runtime_not_running',
  'health_check_not_configured',
  'health_unknown',
  'health_unhealthy',
];

export function evaluateEnvironmentSnapshotFacts(
  facts: EnvironmentSnapshotFacts
): EnvironmentSnapshotResult {
  const hasRuntimeInstance = facts.runtime_status !== null;
  const reasonCodes: EnvironmentSnapshotReasonCode[] = [];

  if (!facts.same_worktree) {
    reasonCodes.push('current_worktree_only');
  }

  if (!facts.has_rendered_snapshot) {
    reasonCodes.push('missing_rendered_snapshot');
  }

  if (!hasRuntimeInstance) {
    reasonCodes.push('missing_runtime_instance');
  } else if (facts.runtime_status !== 'running') {
    reasonCodes.push('runtime_not_running');
  }

  if (!facts.has_health_check_url) {
    reasonCodes.push('health_check_not_configured');
  } else if (facts.health_status === 'unhealthy') {
    reasonCodes.push('health_unhealthy');
  } else if (facts.health_status !== 'healthy') {
    reasonCodes.push('health_unknown');
  }

  const orderedReasons = FAILURE_REASON_ORDER.filter((reasonCode) =>
    reasonCodes.includes(reasonCode)
  );
  const recommendation = orderedReasons.length === 0 ? 'reuse' : 'recommend_fresh';
  const resultReasonCodes =
    recommendation === 'reuse' ? (['eligible_for_reuse'] as const) : orderedReasons;

  return {
    worktree_id: facts.worktree_id,
    environment_variant: facts.environment_variant,
    environment_status: facts.runtime_status,
    health_check: {
      status: facts.health_status,
      timestamp: facts.health_timestamp,
      message: facts.health_message,
    },
    app_url: facts.app_url,
    provenance: {
      same_worktree: facts.same_worktree,
      has_rendered_snapshot: facts.has_rendered_snapshot,
      has_runtime_instance: hasRuntimeInstance,
    },
    reason_codes: [...resultReasonCodes],
    recommendation,
    summary:
      recommendation === 'reuse'
        ? buildReuseSummary(facts)
        : buildFreshRecommendationSummary(orderedReasons),
  };
}

function buildReuseSummary(facts: EnvironmentSnapshotFacts): string {
  const variant = facts.environment_variant ?? 'untracked';
  return `Reuse recommended: rendered snapshot "${variant}" matches a running environment with healthy live checks.`;
}

function buildFreshRecommendationSummary(reasons: EnvironmentSnapshotReasonCode[]): string {
  const detail = reasons
    .map((reasonCode) => FAILURE_REASON_SUMMARIES[reasonCode])
    .filter((value): value is string => Boolean(value))
    .join(' ');

  return `Fresh environment recommended: ${detail}`;
}

const FAILURE_REASON_SUMMARIES: Partial<Record<EnvironmentSnapshotReasonCode, string>> = {
  current_worktree_only: 'Cross-worktree reuse is out of scope in V1.',
  missing_rendered_snapshot: 'No rendered environment snapshot is recorded for this worktree.',
  missing_runtime_instance: 'No runtime instance evidence is available.',
  runtime_not_running: 'The current environment is not running.',
  health_check_not_configured: 'No health check is configured for this worktree.',
  health_unknown: 'Live health evidence is missing or unknown.',
  health_unhealthy: 'The latest health check is unhealthy.',
};
