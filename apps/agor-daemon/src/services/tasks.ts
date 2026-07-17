/**
 * Tasks Service
 *
 * Provides REST + WebSocket API for task management.
 * Uses DrizzleService adapter with TaskRepository.
 */

import { analyticsLogger } from '@agor/core/analytics';
import {
  type ChildCompletionContext,
  renderChildCompletionCallback,
} from '@agor/core/callbacks/child-completion-template';
import { PAGINATION, resolveExecutorHeartbeatConfig } from '@agor/core/config';
import {
  bindRepositoryToTenantUnitOfWork,
  type CompletionCallbackInput,
  enqueueTenantDatabasePostCommitCallback,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  ContentBlock,
  ExecutorClaim,
  ExecutorFinish,
  ExecutorFinishOutcome,
  ExecutorTelemetryReport,
  HistoricalTaskImport,
  NullableId,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  Task,
  UUID,
} from '@agor/core/types';
import {
  finalizeTerminalTaskPatch,
  isNaturalCompletion,
  isTaskTurnHolding,
  isTerminalTaskStatus,
  SessionStatus,
  sanitizeExecutorPulse,
  TaskStatus,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { appendSystemMessage } from '../utils/append-system-message.js';
import {
  type ExecutorHeartbeatCallbackPayload,
  ExecutorHeartbeatCallbackRunner,
} from '../utils/executor-heartbeat-callback.js';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import {
  deferWithTenantContext,
  resolveTenantIdForDeferredScope,
} from '../utils/tenant-db-scope.js';
import type { ExecutorTurnFinalizer } from './executor-turn-finalizer.js';
import type { SessionsService } from './sessions';

/**
 * Task service params
 */
const COMPLETION_SIDE_EFFECT_TASK_STATUSES = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
]);
const HISTORICAL_TASK_IMPORT_FIELDS: ReadonlySet<keyof HistoricalTaskImport> = new Set([
  'session_id',
  'full_prompt',
  'message_range',
  'git_state',
  'tool_use_count',
  'model',
]);

function historicalTaskImports(data: unknown): HistoricalTaskImport[] {
  if (!Array.isArray(data)) throw new BadRequest('Historical tasks must be an array');
  for (const task of data) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new BadRequest('Historical tasks must be objects');
    }
    if (
      typeof (task as HistoricalTaskImport).session_id !== 'string' ||
      typeof (task as HistoricalTaskImport).full_prompt !== 'string' ||
      typeof (task as HistoricalTaskImport).tool_use_count !== 'number' ||
      typeof (task as HistoricalTaskImport).message_range !== 'object' ||
      typeof (task as HistoricalTaskImport).git_state !== 'object'
    ) {
      throw new BadRequest('Historical task fields are invalid');
    }
    const fields = Object.keys(task).filter(
      (field) => !HISTORICAL_TASK_IMPORT_FIELDS.has(field as keyof HistoricalTaskImport)
    );
    if (fields.length) throw new Forbidden(`Historical task fields are not allowed: ${fields}`);
  }
  return data as HistoricalTaskImport[];
}

function isAnalyticsTerminalTaskStatus(status: Task['status'] | undefined): boolean {
  return isTerminalTaskStatus(status);
}

function isCompletionSideEffectTaskStatus(status: Task['status'] | undefined): boolean {
  return status !== undefined && COMPLETION_SIDE_EFFECT_TASK_STATUSES.has(status);
}

function authenticatedExecutorClaim(data: ExecutorClaim, params?: TaskParams): ExecutorClaim {
  const taskId = params?.executorTaskId;
  const attemptId = params?.executorAttemptId;
  if (!taskId || !attemptId) throw new Forbidden('Executor-scoped authentication is required');
  if (data.task_id !== taskId || data.executor_attempt_id !== attemptId) {
    throw new Forbidden('Executor claim does not match authenticated scope');
  }
  return { task_id: taskId, executor_attempt_id: attemptId };
}

export type TaskParams = QueryParams<{
  session_id?: string;
  status?: Task['status'];
}> & {
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlSessionAccessUserId?: UUID;
  /** Authenticated executor attempt; injected by the runtime scope hook. */
  executorAttemptId?: string;
  executorTaskId?: string;
};

/**
 * Extended tasks service with custom methods
 */
export class TasksService extends DrizzleService<Task, Partial<Task>, TaskParams> {
  private taskRepo: TaskRepository;
  private app: Application;
  private db: TenantScopeAwareDatabase;
  private heartbeatCallbackRunner: ExecutorHeartbeatCallbackRunner;

  constructor(
    db: TenantScopeAwareDatabase,
    app: Application,
    private finalizeTurn: ExecutorTurnFinalizer
  ) {
    const taskRepo = new TaskRepository(db);
    super(taskRepo, {
      id: 'task_id',
      resourceType: 'Task',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch'],
    });

    this.taskRepo = bindRepositoryToTenantUnitOfWork(db, taskRepo);
    this.app = app;
    this.db = db;
    const heartbeatConfig = resolveExecutorHeartbeatConfig(app.get?.('config')?.execution);
    this.heartbeatCallbackRunner = new ExecutorHeartbeatCallbackRunner(heartbeatConfig);
  }

  private async patchStoredTask(
    id: string,
    data: Partial<Task>,
    params?: TaskParams
  ): Promise<Task> {
    if (!params?.executorAttemptId) return super.patch(id, data, params) as Promise<Task>;
    const task = await this.taskRepo.update(id, data, params.executorAttemptId);
    if (!task) throw new Conflict('Executor no longer owns task mutations');
    return task;
  }

  /**
   * Override find to support session-based filtering
   */
  async find(params?: TaskParams): Promise<Task[] | Paginated<Task>> {
    if (params?._agorSqlSessionAccessUserId) {
      return super.find(params);
    }

    // If filtering by session_id as a scalar string, use repository shortcut.
    // Note: `session_id` may be injected as `{ $in: [...] }` by the RBAC scoping
    // hook — in that case we fall through to `super.find`, whose adapter's
    // `filterData` handles $in natively.
    if (typeof params?.query?.session_id === 'string') {
      const tasks = await this.taskRepo.findBySession(params.query.session_id);

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? PAGINATION.DEFAULT_LIMIT;
        const skip = params.query.$skip ?? 0;

        return {
          total: tasks.length,
          limit,
          skip,
          data: tasks.slice(skip, skip + limit),
        };
      }

      return tasks;
    }

    // If filtering by status
    if (params?.query?.status === TaskStatus.RUNNING) {
      const tasks = await this.taskRepo.findRunning();

      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? PAGINATION.DEFAULT_LIMIT;
        const skip = params.query.$skip ?? 0;

        return {
          total: tasks.length,
          limit,
          skip,
          data: tasks.slice(skip, skip + limit),
        };
      }

      return tasks;
    }

    // Otherwise use default find
    return super.find(params);
  }

  protected async fetchData(query: Query, params?: TaskParams): Promise<Task[]> {
    const sessionId = query.session_id;
    const filter: Parameters<TaskRepository['findAll']>[0] = {};

    if (typeof sessionId === 'string') {
      filter.sessionId = sessionId as SessionID;
    } else if (
      sessionId &&
      typeof sessionId === 'object' &&
      Array.isArray(sessionId.$in) &&
      sessionId.$in.every((el: unknown) => typeof el === 'string')
    ) {
      filter.sessionIds = sessionId.$in as SessionID[];
    }
    if (typeof query.status === 'string') filter.status = query.status as Task['status'];
    if (params?._agorSqlSessionAccessUserId) {
      filter.visibleToUserId = params._agorSqlSessionAccessUserId;
    }

    return this.taskRepo.findAll(filter);
  }

  /**
   * Override create to atomically update session status when task is created with RUNNING status
   */
  async create(data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
    console.log(
      `🔍 [TasksService.create] Called with status: ${data.status}, TaskStatus.RUNNING: ${TaskStatus.RUNNING}`
    );
    const result = await super.create(data, params);
    console.log(
      `🔍 [TasksService.create] Result is array: ${Array.isArray(result)}, this.app exists: ${!!this.app}`
    );

    // If task is created with RUNNING status, atomically update session status to RUNNING
    // NOTE: create() always returns a single Task (not an array) in practice
    if (data.status === TaskStatus.RUNNING && !Array.isArray(result) && this.app) {
      console.log(`🔍 [TasksService.create] ENTERING session status update block`);
      console.log(`🔍 [TasksService.create] About to patch session ${shortId(result.session_id)}`);
      try {
        const patchResult = await this.app.service('sessions').patch(
          result.session_id,
          {
            status: SessionStatus.RUNNING,
            ready_for_prompt: false,
          },
          params
        );

        console.log(
          `✅ [TasksService] Session ${shortId(result.session_id)} status updated to RUNNING (task ${shortId(result.task_id)} created)`,
          `Patch result status: ${patchResult.status}`
        );
      } catch (error) {
        console.error('❌ [TasksService] Failed to update session status to RUNNING:', error);
      }
    }

    if (!Array.isArray(result)) {
      this.trackTaskCreated(result);
      if (result.status === TaskStatus.RUNNING) {
        this.trackTaskStarted(result);
      }
    }

    return result;
  }

  private baseTaskAnalyticsProperties(task: Task): Record<string, unknown> {
    return {
      task_id: task.task_id,
      session_id: task.session_id,
      status: task.status,
      model: task.model ?? task.normalized_sdk_response?.primaryModel ?? null,
      queue_position: task.queue_position ?? null,
      tool_use_count: task.tool_use_count ?? 0,
      is_callback: task.metadata?.is_agor_callback === true,
      source: task.metadata?.source ?? null,
    };
  }

  private trackTaskCreated(task: Task): void {
    analyticsLogger.track('task.created', this.baseTaskAnalyticsProperties(task), {
      userId: task.created_by,
    });
  }

  private trackTaskStarted(task: Task): void {
    analyticsLogger.track(
      'task.started',
      {
        ...this.baseTaskAnalyticsProperties(task),
        started_at: task.started_at ?? null,
      },
      { userId: task.created_by }
    );
  }

  private trackTaskCompleted(task: Task): void {
    const normalized = task.normalized_sdk_response;
    analyticsLogger.track(
      'task.completed',
      {
        ...this.baseTaskAnalyticsProperties(task),
        completed_at: task.completed_at ?? null,
        duration_ms: task.duration_ms ?? normalized?.durationMs ?? null,
        input_tokens: normalized?.tokenUsage?.inputTokens ?? null,
        output_tokens: normalized?.tokenUsage?.outputTokens ?? null,
        total_tokens: normalized?.tokenUsage?.totalTokens ?? null,
        cost_usd: normalized?.costUsd ?? null,
        context_window_limit: normalized?.contextWindowLimit ?? null,
        context_window_percentage: normalized?.contextUsageSnapshot?.percentage ?? null,
        has_error: Boolean(task.error_message),
      },
      { userId: task.created_by }
    );
  }

  private async handleExecutorHeartbeat(task: Task, heartbeatAt: string): Promise<void> {
    const payload: ExecutorHeartbeatCallbackPayload = {
      event: 'executor_heartbeat',
      task_id: task.task_id,
      session_id: task.session_id,
      last_executor_heartbeat_at: heartbeatAt,
    };

    try {
      const session = await this.app.service('sessions').get(task.session_id);
      if (session?.branch_id) {
        payload.branch_id = session.branch_id;
      }
    } catch (error) {
      console.warn(
        `⚠️  [TasksService] Could not resolve branch_id for heartbeat task ${shortId(task.task_id)}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    this.heartbeatCallbackRunner.run(payload);
  }

  private publishExecutorHeartbeat(task: Task, heartbeatAt: string): void {
    analyticsLogger.track(
      'executor.heartbeat',
      {
        task_id: task.task_id,
        session_id: task.session_id,
        status: task.status,
        last_executor_heartbeat_at: heartbeatAt,
      },
      { userId: task.created_by }
    );
    this.handleExecutorHeartbeat(task, heartbeatAt).catch((error) => {
      console.warn(
        `⚠️  [TasksService] Executor heartbeat callback failed for task ${shortId(task.task_id)}:`,
        error
      );
    });
  }

  private async runAfterTenantDatabaseCommit(
    label: string,
    work: () => Promise<void>
  ): Promise<void> {
    const run = async () => {
      try {
        await work();
      } catch (error) {
        console.warn(
          `⚠️  [TasksService] ${label} failed:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    if (enqueueTenantDatabasePostCommitCallback(run)) {
      return;
    }

    await run();
  }

  private async triggerQueueProcessingAfterCommit(
    sessionId: string,
    params?: TaskParams
  ): Promise<void> {
    const sessionsService = this.app.service('sessions') as unknown as SessionsService;
    const sessionParams = params as Parameters<SessionsService['triggerQueueProcessing']>[1];

    await this.runAfterTenantDatabaseCommit('triggerQueueProcessing', () =>
      sessionsService.triggerQueueProcessing(sessionId, sessionParams)
    );
  }

  /** Run causally visible completion effects only after the turn is safe to continue. */
  private async settleTaskCompletion(
    task: Task,
    params?: TaskParams,
    callbacksSettled = false
  ): Promise<void> {
    const session = await this.app.service('sessions').get(task.session_id, params);
    if (session.branch_id) {
      this.app
        .service('branches')
        .get(session.branch_id, params)
        .then((branch) =>
          branch?.repo_id
            ? ensureRepoOriginAlignedById(this.app, branch.repo_id, params)
            : undefined
        )
        .catch((error: unknown) =>
          console.warn(
            `⚠️  [TasksService] Repository realignment failed for session ${shortId(task.session_id)}:`,
            error instanceof Error ? error.message : String(error)
          )
        );
    }

    // Executor release projects this state atomically with released_at. Legacy
    // turns have no release record, so terminal is their settlement boundary.
    if (!task.executor_attempt) {
      await this.app.service('sessions').patch(
        task.session_id,
        {
          status: task.status === TaskStatus.FAILED ? SessionStatus.FAILED : SessionStatus.IDLE,
          ready_for_prompt: true,
        },
        params
      );
    }

    const naturalCompletion = isNaturalCompletion(task.status);
    if (naturalCompletion && !callbacksSettled) {
      await this.dispatchCompletionCallbacks(task, session, params);
    }

    if (session.fork_origin === 'btw' && isCompletionSideEffectTaskStatus(task.status)) {
      await this.app
        .service('sessions')
        .patch(session.session_id, { archived: true, archived_reason: 'btw_completed' })
        .catch((error: unknown) =>
          console.warn('⚠️  [TasksService] Failed to auto-archive btw fork:', error)
        );
      if (naturalCompletion) await this.injectBtwResultMessage(task, session, params);
    }

    await this.triggerQueueProcessingAfterCommit(task.session_id, params);
  }

  /**
   * Override patch to detect task completion and:
   * 1. Atomically update session status to IDLE when task reaches terminal state
   * 2. Set ready_for_prompt flag
   * 3. Queue callback to parent session (if exists)
   *
   * NOTE: Tasks are only ever patched one at a time (never in bulk), so we don't need to loop.
   */
  async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
    const nextStatus = data.status;
    if (params?.executorAttemptId && nextStatus) {
      if (
        nextStatus === TaskStatus.RUNNING ||
        nextStatus === TaskStatus.AWAITING_PERMISSION ||
        nextStatus === TaskStatus.AWAITING_INPUT
      ) {
        const transitioned = await this.taskRepo.transitionExecutorRuntime(
          id,
          params.executorAttemptId,
          nextStatus
        );
        if (!transitioned) throw new Conflict('Executor no longer owns this task state');
        const { status: _status, ...rest } = data;
        const result = Object.keys(rest).length
          ? await this.patchStoredTask(id, rest, params)
          : transitioned;
        if (nextStatus === TaskStatus.RUNNING) this.trackTaskStarted(result as Task);
        return result;
      }
      if (isTerminalTaskStatus(nextStatus)) {
        if (!params.executorTaskId) throw new Conflict('Executor task scope is incomplete');
        const { status: _status, ...updates } = data;
        const finish: ExecutorFinish = {
          ...updates,
          task_id: params.executorTaskId,
          executor_attempt_id: params.executorAttemptId,
          status: nextStatus,
        };
        return this.acceptExecutorFinish(finish, params, false);
      }
      throw new Conflict(`Executor cannot transition task to ${nextStatus}`);
    }
    const currentTask = nextStatus !== undefined ? await this.get(id, params) : undefined;
    if (currentTask && isTerminalTaskStatus(currentTask.status) && nextStatus !== undefined) {
      console.warn(
        `⏭️ [TasksService] Ignoring status rewrite for terminal task ${shortId(currentTask.task_id)} ` +
          `(${currentTask.status} → ${nextStatus})`
      );
      return currentTask;
    }
    const isAnalyticsTerminalTransition =
      isAnalyticsTerminalTaskStatus(nextStatus) &&
      !isAnalyticsTerminalTaskStatus(currentTask?.status);
    const isCompletionSideEffectTransition =
      isCompletionSideEffectTaskStatus(nextStatus) &&
      !isCompletionSideEffectTaskStatus(currentTask?.status);
    const isRunningTransition =
      nextStatus === TaskStatus.RUNNING && currentTask?.status !== TaskStatus.RUNNING;

    // When transitioning to a terminal status, auto-compute duration, completed_at,
    // and end_timestamp. This ensures ALL code paths (complete, fail, stop handler)
    // get correct timing data without duplicating logic.
    if (isAnalyticsTerminalTransition && currentTask) {
      data = finalizeTerminalTaskPatch(currentTask, data);
    }

    const result = await this.patchStoredTask(id, data, params);

    if (isRunningTransition && !Array.isArray(result)) {
      this.trackTaskStarted(result as Task);
    }

    if (data.last_executor_heartbeat_at && !Array.isArray(result)) {
      this.publishExecutorHeartbeat(result as Task, data.last_executor_heartbeat_at);
    }

    // Emit analytics for terminal task transitions, including timeouts that do not
    // run the broader task-completion side effects below.
    if (isAnalyticsTerminalTransition) {
      const task = result as Task;
      this.trackTaskCompleted(task);
    }

    // Run completion side effects only for statuses that historically completed
    // executor turns. Timeout paths patch session state separately and should not
    // enqueue callbacks, mark sessions promptable, archive forks, or drain queues here.
    if (isCompletionSideEffectTransition) {
      const task = result as Task;
      const awaitingExecutorRelease = isTaskTurnHolding(task) && isTerminalTaskStatus(task.status);
      if (awaitingExecutorRelease) {
        console.log(`⏳ [TasksService] Task ${shortId(task.task_id)} awaits executor release`);
      } else {
        await this.settleTaskCompletion(task, params).catch((error) =>
          console.error('❌ [TasksService] Failed to settle task completion:', error)
        );
      }
    }

    return result;
  }

  /**
   * Inject a btw result message into the parent session's conversation.
   * This is a system message that appears in the UI but does NOT trigger a prompt cycle.
   * Shows: originating session (if remote), the question asked, and the response.
   */
  private async injectBtwResultMessage(
    task: Task,
    btwSession: Session,
    _params?: TaskParams
  ): Promise<void> {
    const parentSessionId = btwSession.genealogy?.forked_from_session_id;
    if (!parentSessionId) return;

    try {
      const messagesService = this.app.service('messages');

      // Fetch all messages from the btw fork's task to extract prompt + response
      const messagesResult = await messagesService.find({
        query: {
          session_id: btwSession.session_id,
          task_id: task.task_id,
        },
      });

      const allMessages = messagesResult.data || messagesResult;
      const messageList = Array.isArray(allMessages) ? allMessages : [];

      // Extract the original prompt (first user message or task description)
      // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
      const userMessages = messageList.filter((msg: any) => msg.role === 'user');
      let promptText = '';
      if (userMessages.length > 0) {
        const firstUser = userMessages[0];
        promptText =
          typeof firstUser.content === 'string'
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? firstUser.content
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .filter((b: any) => b.type === 'text')
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .map((b: any) => b.text || '')
                  .join('\n\n')
              : '';
      }
      if (!promptText) {
        promptText = task.full_prompt?.substring(0, 120) || btwSession.title || '(no prompt)';
      }

      // Extract the last assistant response
      const assistantMessages = messageList
        // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
        .filter((msg: any) => msg.role === 'assistant')
        // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
        .sort((a: any, b: any) => (b.index || 0) - (a.index || 0));

      let responseText = '';
      if (assistantMessages.length > 0) {
        const lastMsg = assistantMessages[0];
        responseText =
          typeof lastMsg.content === 'string'
            ? lastMsg.content
            : Array.isArray(lastMsg.content)
              ? lastMsg.content
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .filter((block: any) => block.type === 'text')
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .map((block: any) => block.text || '')
                  .join('\n\n')
              : '';
      }

      if (!responseText) {
        responseText = `(btw fork completed with status: ${task.status}, but no text response was found)`;
      }

      // Find the parent's current running task to attach the message to
      const parentSession = await this.app.service('sessions').get(parentSessionId);
      const parentLatestTaskId = parentSession.tasks?.[parentSession.tasks.length - 1];

      // For remote btw, fetch the caller session's title
      const callerSessionId = btwSession.callback_config?.callback_session_id;
      let callerTitle: string | undefined;
      if (callerSessionId) {
        try {
          const callerSession = await this.app.service('sessions').get(callerSessionId);
          callerTitle = callerSession.title;
        } catch {
          // Caller session may have been deleted — not critical
        }
      }

      // Build preview from prompt + response
      const previewText = `Q: ${promptText.substring(0, 80)} → A: ${responseText.substring(0, 100)}`;

      // Create via service so FeathersJS broadcasts the `created` event to all clients
      await appendSystemMessage({
        app: this.app,
        db: this.db,
        sessionId: parentSessionId,
        taskId: parentLatestTaskId as string | undefined,
        content: [{ type: 'text', text: responseText } as ContentBlock],
        contentPreview: previewText.substring(0, 200),
        metadata: {
          is_btw_result: true,
          // The ephemeral btw fork session
          btw_session_id: btwSession.session_id,
          btw_task_id: task.task_id,
          btw_status: task.status,
          btw_title: btwSession.title,
          btw_prompt: promptText,
          // For remote btw: the session that initiated the btw (via MCP callback_session_id).
          // Absent for local btw (user clicked btw button from parent session's UI).
          btw_caller_session_id: btwSession.callback_config?.callback_session_id,
          btw_caller_title: callerTitle,
          source: 'agor',
        },
      });

      console.log(
        `💬 [TasksService] Injected btw result message into parent session ${shortId(parentSessionId)} from btw fork ${shortId(btwSession.session_id)}`
      );
    } catch (error) {
      console.warn(`⚠️  [TasksService] Failed to inject btw result message:`, error);
      // Non-critical — don't break task completion
    }
  }

  /**
   * Centralized completion-callback dispatcher.
   *
   * Both subsessions and generic callback_config callbacks resolve to the same
   * target/event pair: `session_completion` delivered to
   * `callback_config.callback_session_id`, with a genealogy-parent fallback for
   * legacy spawned sessions. Keeping all routing here prevents a completed child
   * from notifying its parent once via the rich/template path and again via a
   * second generic/raw path.
   */
  private async dispatchCompletionCallbacks(
    task: Task,
    childSession: Session,
    params?: TaskParams
  ): Promise<void> {
    const targetSessionId = this.resolveCompletionCallbackTarget(childSession);
    if (!targetSessionId) return;
    const input = await this.prepareCompletionCallback(task, childSession, targetSessionId, params);
    if (!input) return;
    const callbackTask = await this.taskRepo.createCompletionCallback(input).catch((error) => {
      console.error(`❌ [TasksService] Failed to queue callback to ${targetSessionId}:`, error);
      return null;
    });
    if (!callbackTask) return;
    await this.publishCompletionCallback(callbackTask);

    // Post-callback cleanup: only runs after a callback task was actually
    // queued. "once" means "after firing" — do not permanently disable a
    // one-shot callback when delivery was skipped or failed before queueing.
    // Default to "persistent" for backward compat — legacy sessions without
    // callback_mode should continue firing on every completion as they always have.
    const callbackMode = childSession.callback_config?.callback_mode ?? 'persistent';
    if (callbackMode === 'once') {
      try {
        await this.app.service('sessions').patch(childSession.session_id, {
          callback_config: {
            ...childSession.callback_config,
            enabled: false,
          },
        });
        console.log(
          `🔕 [TasksService] Auto-disabled callback for session ${shortId(childSession.session_id)} (once mode)`
        );
      } catch (error) {
        console.warn(`⚠️  [TasksService] Failed to auto-disable callback:`, error);
      }
    }
  }

  private async publishCompletionCallback(task: Task): Promise<void> {
    this.emit?.('queued', task);
    console.log(
      `🔔 Queued callback task ${shortId(task.task_id)} on session ${shortId(task.session_id)}`
    );
    await this.triggerQueueProcessingAfterCommit(task.session_id, {}).catch((error) =>
      console.warn(`⚠️  [TasksService] Callback queue wake-up deferred to recovery:`, error)
    );
  }

  private resolveCompletionCallbackTarget(childSession: Session): SessionID | undefined {
    // callback_config.callback_session_id is the single source of truth for both:
    // - Subsessions (spawn sets it to parent session ID)
    // - Remote sessions (create sets it when enableCallback is true)
    // Fallback: legacy spawned sessions may only have genealogy.parent_session_id.
    return (
      childSession.callback_config?.callback_session_id ?? childSession.genealogy?.parent_session_id
    );
  }

  /**
   * Queue callback message to a target session when a session completes.
   * The target is always callback_config.callback_session_id, set by both
   * spawn (defaults to parent) and create (when enableCallback is true).
   */
  private async prepareCompletionCallback(
    task: Task,
    childSession: Session,
    targetSessionId: SessionID,
    params?: TaskParams
  ): Promise<CompletionCallbackInput | undefined> {
    if (!targetSessionId) return undefined;
    // Get target session to check callback config
    // NOTE: DO NOT pass params here - params are from child session context (executor),
    // but we need to access target session without child's authentication constraints
    const targetSession = await this.app
      .service('sessions')
      .get(targetSessionId)
      .catch((error) => {
        if (error instanceof NotFound) return undefined;
        throw error;
      });
    if (!targetSession) return undefined;

    // Check callback config - child overrides take precedence over target defaults
    // For subsessions (parent_session_id), default is enabled=true
    // For remote sessions (callback_session_id), enabled is explicitly set at creation time
    const callbackEnabled =
      childSession.callback_config?.enabled ?? targetSession.callback_config?.enabled ?? true;

    if (!callbackEnabled) {
      console.log(
        `⏭️  [TasksService] Callbacks disabled for child session ${shortId(childSession.session_id)}`
      );
      return undefined;
    }

    // Check if we should include original spawn prompt - child overrides take precedence
    const includeOriginalPrompt =
      childSession.callback_config?.include_original_prompt ??
      targetSession.callback_config?.include_original_prompt ??
      false;

    // Get the original prompt from the completed task. When requested, it is
    // rendered as a section inside the single templated callback body (never
    // queued as its own callback/message).
    const spawnPrompt = includeOriginalPrompt
      ? task.full_prompt || '(no prompt available)'
      : undefined;

    // Fetch last assistant message from child session (if callback config allows)
    let lastAssistantMessage: string | undefined;

    // Check if we should include last message - child overrides take precedence
    const includeLastMessage =
      childSession.callback_config?.include_last_message ??
      targetSession.callback_config?.include_last_message ??
      true;

    if (includeLastMessage) {
      try {
        // Query messages service for last assistant message in this task
        const messagesService = this.app.service('messages');
        const messages = await messagesService.find({
          ...params,
          query: {
            session_id: childSession.session_id,
            task_id: task.task_id,
          },
        });

        // MessagesService.find() ignores role/sort/limit when task_id is present
        // So we need to filter and sort manually
        const allMessages = messages.data || messages;
        const assistantMessages = (Array.isArray(allMessages) ? allMessages : [])
          // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
          .filter((msg: any) => msg.role === 'assistant')
          // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
          .sort((a: any, b: any) => (b.index || 0) - (a.index || 0)); // Descending by index

        if (assistantMessages.length > 0) {
          const lastMsg = assistantMessages[0];
          // Extract text content from content blocks or string
          if (typeof lastMsg.content === 'string') {
            lastAssistantMessage = lastMsg.content;
          } else if (Array.isArray(lastMsg.content)) {
            // Find text blocks and concatenate
            const textBlocks = lastMsg.content
              // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
              .filter((block: any) => block.type === 'text')
              // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
              .map((block: any) => block.text || '')
              .join('\n\n');
            lastAssistantMessage = textBlocks || undefined;
          }
        }
      } catch (error) {
        console.warn(
          `⚠️  [TasksService] Could not fetch last assistant message for callback:`,
          error
        );
        // Continue without last message - not critical
      }
    }

    // Build callback context
    const context: ChildCompletionContext = {
      childSessionId: shortId(childSession.session_id),
      childSessionFullId: childSession.session_id,
      childTaskId: shortId(task.task_id),
      childTaskFullId: task.task_id,
      parentSessionId: shortId(targetSessionId), // backward compat
      callbackSessionId: shortId(targetSessionId),
      spawnPrompt,
      status: task.status, // COMPLETED, FAILED, etc.
      completedAt: task.completed_at || new Date().toISOString(),
      messageCount:
        task.message_range?.end_index !== undefined && task.message_range?.start_index !== undefined
          ? task.message_range.end_index - task.message_range.start_index + 1
          : 0,
      toolUseCount: task.tool_use_count || 0,
      lastAssistantMessage,
    };

    // Render callback message using template
    const customTemplate = targetSession.callback_config?.template;
    const callbackMessage = renderChildCompletionCallback(context, customTemplate);

    // Validate target session has a creator for authentication
    if (!targetSession.created_by) {
      console.warn(
        `⚠️  [TasksService] Cannot queue callback: target session ${shortId(targetSessionId)} has no creator (anonymous session)`
      );
      return undefined;
    }

    // Create QUEUED task on the target session carrying the callback prompt.
    // The metadata bag survives the queue → run transition: startClaimedTask
    // re-stamps `is_agor_callback` and `source` onto the synthesized
    // user-message row so the UI's callback styling (MessageBlock.tsx) holds.
    //
    // IMPORTANT: queued_by_user_id = the person who set up the callback
    // (task attribution), NOT the target session owner. Execution still runs
    // as the target session's Unix user. Falls back to target session creator
    // for backward compat (legacy sessions without callback_created_by).
    const callbackCreator =
      childSession.callback_config?.callback_created_by ?? targetSession.created_by;
    return {
      sourceTaskId: task.task_id,
      targetSessionId,
      fullPrompt: callbackMessage,
      createdBy: callbackCreator,
      metadata: {
        is_agor_callback: true,
        source: 'agor',
        child_session_id: childSession.session_id,
        child_task_id: task.task_id,
        queued_by_user_id: callbackCreator,
      },
    };
  }

  /**
   * Custom method: Get running tasks across all sessions
   */
  async getRunning(_params?: TaskParams): Promise<Task[]> {
    return this.taskRepo.findRunning();
  }

  /**
   * Custom method: Get active or terminal-unreleased executor turns.
   */
  async getOrphaned(_params?: TaskParams): Promise<Task[]> {
    return this.taskRepo.findOrphaned();
  }

  async getQueuedSessionIds(_params?: TaskParams): Promise<SessionID[]> {
    return [
      ...new Set(
        (await this.taskRepo.findByStatus(TaskStatus.QUEUED)).map((task) => task.session_id)
      ),
    ];
  }

  async remove(id: NullableId, _params?: TaskParams): Promise<Task | Task[]> {
    if (id === null) throw new BadRequest('Bulk task removal is not supported');
    const removed = await this.taskRepo.removePending(String(id));
    if (!removed) throw new Conflict('Only pending tasks can be removed');
    return removed;
  }

  /** Reserve Stop under the same database lock used by admission and release. */
  async reserveExecutorStop(sessionId: SessionID, params?: TaskParams): Promise<Task | null> {
    const result = await this.taskRepo.reserveExecutorStop(sessionId);
    if (result.task && result.transitioned) {
      this.trackTaskCompleted(result.task);
      this.emit?.('patched', result.task);
    }

    const session = await this.app.service('sessions').get(sessionId, params);
    this.app.service('sessions').emit('patched', session);
    if (!result.task) await this.triggerQueueProcessingAfterCommit(sessionId, params);
    else if (!result.task.executor_attempt) await this.settleTaskCompletion(result.task, params);
    return result.task;
  }

  /** Claim a dispatched task after task-scoped executor authentication. */
  async connectExecutor(data: ExecutorClaim, params?: TaskParams): Promise<Task> {
    if (!data.task_id || !data.executor_attempt_id) throw new BadRequest('Invalid executor claim');
    const claim = authenticatedExecutorClaim(data, params);
    const connection = await this.taskRepo.connectExecutor(
      claim.task_id,
      claim.executor_attempt_id
    );
    if (!connection) throw new Conflict('Executor does not own this dispatched task');
    if (connection.transitioned) {
      this.trackTaskStarted(connection.task);
      this.emit?.('patched', connection.task);
    }
    return connection.task;
  }

  /** Stamp bounded executor liveness/progress with daemon time. */
  async reportExecutorTelemetry(data: ExecutorTelemetryReport, params?: TaskParams): Promise<Task> {
    if (!data.task_id || !data.executor_attempt_id || typeof data.heartbeat !== 'boolean') {
      throw new BadRequest('Invalid executor telemetry');
    }
    const pulse = data.pulse === undefined ? undefined : sanitizeExecutorPulse(data.pulse);
    if (data.pulse !== undefined && !pulse) throw new BadRequest('Invalid executor pulse');
    if (!data.heartbeat && !pulse) throw new BadRequest('Executor telemetry is empty');
    const claim = authenticatedExecutorClaim(data, params);

    const observedAt = new Date().toISOString();
    const task = await this.taskRepo.recordExecutorTelemetry(
      claim.task_id,
      claim.executor_attempt_id,
      {
        ...(data.heartbeat ? { last_executor_heartbeat_at: observedAt } : {}),
        ...(pulse ? { latest_executor_pulse: { ...pulse, at: observedAt } } : {}),
      }
    );
    if (!task) throw new Conflict('Executor telemetry is no longer accepted');
    this.emit?.('patched', task);
    if (data.heartbeat) this.publishExecutorHeartbeat(task, observedAt);
    return task;
  }

  private async acceptExecutorFinish(
    data: ExecutorFinish,
    params: TaskParams | undefined,
    allowUnconnected: boolean
  ): Promise<Task> {
    const result = await this.taskRepo.finishExecutorAttempt(
      data.task_id,
      data.executor_attempt_id,
      data,
      allowUnconnected
    );
    if (!result) throw new Conflict('Executor attempt is not ready to finish');
    if (result.transitioned) {
      this.trackTaskCompleted(result.task);
      this.emit?.('patched', result.task);
    }
    if (!resolveTenantIdForDeferredScope(params))
      throw new Conflict('Missing executor tenant scope');
    deferWithTenantContext(
      params,
      async () => {
        await this.finalizeTurn(
          { task_id: data.task_id, executor_attempt_id: data.executor_attempt_id },
          params
        );
      },
      (error) => console.warn('⚠️  [TasksService] Executor finalization failed:', error)
    );
    return result.task;
  }

  /** Accept the executor's final outcome as its last write, then finalize asynchronously. */
  async finishExecutorAttempt(data: ExecutorFinish, params?: TaskParams): Promise<Task> {
    if (!data.task_id || !data.executor_attempt_id || !isTerminalTaskStatus(data.status)) {
      throw new BadRequest('Invalid executor finish');
    }
    const claim = authenticatedExecutorClaim(data, params);
    return this.acceptExecutorFinish({ ...data, ...claim }, params, false);
  }

  /** Daemon-owned failure before an executor can connect. */
  failExecutorStart(task: Task, error: unknown, params?: TaskParams): Promise<Task> {
    const attemptId = task.executor_attempt?.id;
    if (!attemptId) throw new Conflict('Claimed task has no executor attempt');
    const message = error instanceof Error ? error.message : String(error);
    return this.acceptExecutorFinish(
      {
        task_id: task.task_id,
        executor_attempt_id: attemptId,
        status: TaskStatus.FAILED,
        error_message: message,
      },
      params,
      true
    );
  }

  finishDaemonAttempt(
    task: Task,
    finish: ExecutorFinishOutcome,
    params?: TaskParams
  ): Promise<Task> {
    const attemptId = task.executor_attempt?.id;
    if (!attemptId) throw new Conflict('Task has no executor attempt');
    return this.acceptExecutorFinish(
      { task_id: task.task_id, executor_attempt_id: attemptId, ...finish },
      params,
      true
    );
  }

  async releaseExecutorTurn(data: ExecutorClaim, params?: TaskParams): Promise<Task> {
    if (!data.task_id || !data.executor_attempt_id)
      throw new BadRequest('Invalid executor release');
    const current = await this.get(data.task_id, params);
    const session = await this.app.service('sessions').get(current.session_id, params);
    const target = isNaturalCompletion(current.status)
      ? this.resolveCompletionCallbackTarget(session)
      : undefined;
    const callback = target
      ? await this.prepareCompletionCallback(current, session, target, params)
      : undefined;
    const result = await this.taskRepo.releaseExecutorTurn(
      data.task_id,
      data.executor_attempt_id,
      callback && {
        ...callback,
        disableAfterDelivery: session.callback_config?.callback_mode === 'once',
      }
    );
    if (!result) throw new Conflict('Executor turn is not releasable');
    if (result.released) {
      (
        this.app as Application & {
          sessionTokenService?: { revokeExecutorAttemptTokens(attemptId: string): void };
        }
      ).sessionTokenService?.revokeExecutorAttemptTokens(data.executor_attempt_id);
      this.emit?.('patched', result.task);
      if (result.callbackTask) await this.publishCompletionCallback(result.callbackTask);
      this.app
        .service('sessions')
        .emit('patched', await this.app.service('sessions').get(result.task.session_id, params));
      await this.settleTaskCompletion(result.task, params, true);
    }
    return result.task;
  }

  finalizeExecutorTurn(data: ExecutorClaim, params?: TaskParams): Promise<Task> {
    return this.finalizeTurn(data, params);
  }

  /** Import transcript history through a DTO that excludes every live lifecycle field. */
  async importHistorical(data: unknown, createdBy: string): Promise<Task[]> {
    return this.taskRepo.importHistorical(historicalTaskImports(data), createdBy);
  }
}

/**
 * Service factory function
 */
export function createTasksService(
  db: TenantScopeAwareDatabase,
  app: Application,
  finalizer: ExecutorTurnFinalizer
): TasksService {
  return new TasksService(db, app, finalizer);
}
