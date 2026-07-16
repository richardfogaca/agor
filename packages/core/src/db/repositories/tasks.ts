/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import type {
  HistoricalTaskImport,
  SessionID,
  Task,
  TaskID,
  TaskMetadata,
  UUID,
} from '@agor/core/types';
import {
  EXECUTING_TASK_STATUSES,
  finalizeTerminalTaskPatch,
  isTaskTurnHolding,
  isTerminalTaskStatus,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { generateId, shortId } from '../../lib/ids';
import { SESSION_COMPLETION_CALLBACK_EVENT } from '../../types/task';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  jsonExtract,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { sessions, type TaskInsert, type TaskRow, tasks } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { visibleSessionReferenceAccessExists } from './branch-access';
import { deepMerge } from './merge-utils';

function taskTurnHoldingWhere(db: Database, sessionId?: SessionID) {
  const holding = or(
    inArray(tasks.status, [...EXECUTING_TASK_STATUSES]),
    and(
      sql`${jsonExtract(db, tasks.data, 'executor_attempt.id')} is not null`,
      sql`${jsonExtract(db, tasks.data, 'executor_attempt.released_at')} is null`
    )
  );
  return sessionId ? and(eq(tasks.session_id, sessionId), holding) : holding;
}

export interface CompletionCallbackInput {
  sourceTaskId: TaskID;
  targetSessionId: SessionID;
  fullPrompt: string;
  createdBy: string;
  metadata: TaskMetadata;
}

/**
 * Task repository implementation
 */
export class TaskRepository implements BaseRepository<Task, Partial<Task>> {
  constructor(private db: Database) {}

  private lockTask(db: Database, taskId: string): Promise<void> {
    return lockRowForUpdate(db, this.db, tasks, eq(tasks.task_id, taskId));
  }

  private lockSession(db: Database, sessionId: SessionID): Promise<void> {
    return lockRowForUpdate(db, this.db, sessions, eq(sessions.session_id, sessionId));
  }

  private async loadLockedTask(db: Database, taskId: string, requestedId = taskId): Promise<Task> {
    await this.lockTask(db, taskId);
    const row = await select(db).from(tasks).where(eq(tasks.task_id, taskId)).one();
    if (!row) throw new EntityNotFoundError('Task', requestedId);
    return this.rowToTask(row);
  }

  private async resolveExisting(id: string): Promise<{ fullId: string; task: Task }> {
    const fullId = await this.resolveId(id);
    const task = await this.findById(fullId);
    if (!task) throw new EntityNotFoundError('Task', id);
    return { fullId, task };
  }

  private queuedTaskInsert(
    input: {
      sessionId: SessionID;
      fullPrompt: string;
      createdBy: string;
      metadata?: TaskMetadata;
    },
    queuePosition: number
  ): TaskInsert {
    return this.taskToInsert({
      session_id: input.sessionId,
      full_prompt: input.fullPrompt,
      created_by: input.createdBy,
      status: TaskStatus.QUEUED,
      queue_position: queuePosition,
      metadata: input.metadata,
      message_range: {
        start_index: -1,
        end_index: -1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: '', sha_at_start: '' },
      tool_use_count: 0,
    });
  }

  /**
   * Convert database row to Task type
   */
  private rowToTask(row: TaskRow): Task {
    return {
      task_id: row.task_id as UUID,
      session_id: row.session_id as UUID,
      status: row.status,
      queue_position: row.queue_position ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      started_at: row.started_at ? new Date(row.started_at).toISOString() : undefined,
      executor_connected_at: row.executor_connected_at
        ? new Date(row.executor_connected_at).toISOString()
        : undefined,
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
      last_executor_heartbeat_at: row.last_executor_heartbeat_at
        ? new Date(row.last_executor_heartbeat_at).toISOString()
        : undefined,
      created_by: row.created_by,
      session_md5: row.session_md5 ?? undefined,
      ...row.data,
    };
  }

  /**
   * Convert Task to database insert format
   */
  private taskToInsert(task: Partial<Task>): TaskInsert {
    const now = Date.now();
    const taskId = task.task_id ?? generateId();

    if (!task.session_id) {
      throw new RepositoryError('session_id is required when creating a task');
    }
    if (!task.created_by) {
      throw new RepositoryError('created_by is required when creating a task');
    }

    // Ensure git_state always has required fields
    const git_state = task.git_state ?? {
      ref_at_start: 'unknown',
      sha_at_start: 'unknown',
    };

    return {
      task_id: taskId,
      session_id: task.session_id,
      created_at: new Date(now), // Always use server timestamp, ignore client-provided value
      started_at: task.started_at ? new Date(task.started_at) : undefined,
      executor_connected_at: task.executor_connected_at
        ? new Date(task.executor_connected_at)
        : undefined,
      completed_at: task.completed_at ? new Date(task.completed_at) : undefined,
      last_executor_heartbeat_at: task.last_executor_heartbeat_at
        ? new Date(task.last_executor_heartbeat_at)
        : undefined,
      status: task.status ?? TaskStatus.CREATED,
      queue_position: task.queue_position ?? null,
      created_by: task.created_by,
      session_md5: task.session_md5 ?? null,
      data: {
        full_prompt: task.full_prompt ?? '',
        message_range: task.message_range ?? {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date(now).toISOString(),
        },
        git_state,
        // Filled in by the executor after the turn — don't substitute a default.
        ...(task.model ? { model: task.model } : {}),
        tool_use_count: task.tool_use_count ?? 0,
        duration_ms: task.duration_ms, // Task execution duration
        agent_session_id: task.agent_session_id, // SDK session ID
        error_message: task.error_message, // Human-readable failure reason when status='failed'
        raw_sdk_response: task.raw_sdk_response, // Raw SDK response - single source of truth for token accounting
        normalized_sdk_response: task.normalized_sdk_response, // Normalized for UI consumption
        computed_context_window: task.computed_context_window, // Cumulative context window (computed by tool.computeContextWindow())
        report: task.report,
        permission_request: task.permission_request, // Permission state for UI approval flow
        executor_attempt: task.executor_attempt,
        latest_executor_pulse: task.latest_executor_pulse,
        metadata: task.metadata, // Generic metadata bag (e.g., is_agor_callback, source)
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Task', async (pattern) => {
      const rows = await select(this.db)
        .from(tasks)
        .where(like(tasks.task_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { task_id: string }) => r.task_id);
    });
  }

  /**
   * Create a new task
   */
  async create(data: Partial<Task>): Promise<Task> {
    try {
      const insertData = this.taskToInsert(data);
      await insert(this.db, tasks).values(insertData).run();

      const row = await select(this.db)
        .from(tasks)
        .where(eq(tasks.task_id, insertData.task_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created task');
      }

      return this.rowToTask(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Import terminal transcript history without accepting live lifecycle state. */
  async importHistorical(taskList: HistoricalTaskImport[], createdBy: string): Promise<Task[]> {
    try {
      if (taskList.length === 0) return [];
      const inserts = taskList.map((task) => ({
        ...this.taskToInsert({
          ...task,
          created_by: createdBy,
          status: TaskStatus.COMPLETED,
          completed_at: task.message_range.end_timestamp,
        }),
        created_at: new Date(task.message_range.start_timestamp),
      }));

      // Bulk insert all tasks
      await insert(this.db, tasks).values(inserts).run();

      // Retrieve all inserted tasks. SQLite SELECT order is undefined without
      // an ORDER BY — we used to rely on UUIDv7's monotonic counter to make
      // `id ASC` mirror insertion order, but `generateId` now passes random
      // bytes to `uuid.v7()` (so 24-char short IDs don't collide for same-ms
      // IDs), which breaks sub-ms sort. Re-impose insertion order explicitly
      // by mapping returned rows back to the input order. Use drizzle's
      // `inArray` so the query is parameterized rather than string-built.
      const taskIds = inserts.map((t) => t.task_id);
      const rows = await select(this.db).from(tasks).where(inArray(tasks.task_id, taskIds)).all();

      const rowsById = new Map(rows.map((r: TaskRow) => [r.task_id, r]));
      return taskIds.map((id) => this.rowToTask(rowsById.get(id) as TaskRow));
    } catch (error) {
      throw new RepositoryError(
        `Failed to import tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find task by ID (supports short ID)
   */
  async findById(id: string): Promise<Task | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(tasks).where(eq(tasks.task_id, fullId)).one();

      return row ? this.rowToTask(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all tasks
   */
  async findAll(filter?: {
    sessionId?: SessionID;
    sessionIds?: SessionID[];
    status?: Task['status'];
    visibleToUserId?: UUID;
  }): Promise<Task[]> {
    try {
      if (filter?.sessionIds !== undefined && filter.sessionIds.length === 0) return [];

      const conditions = [];
      if (filter?.sessionId) conditions.push(eq(tasks.session_id, filter.sessionId));
      if (filter?.sessionIds !== undefined)
        conditions.push(inArray(tasks.session_id, filter.sessionIds));
      if (filter?.status) conditions.push(eq(tasks.status, filter.status));
      if (filter?.visibleToUserId) {
        conditions.push(
          visibleSessionReferenceAccessExists(this.db, filter.visibleToUserId, tasks.session_id)
        );
      }

      const query = select(this.db).from(tasks);
      const rows =
        conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();
      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all tasks for a session
   */
  async findBySession(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .orderBy(tasks.created_at)
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find running tasks across all sessions
   */
  async findRunning(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(eq(tasks.status, TaskStatus.RUNNING))
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find running tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find active or unreleased executor turns interrupted when the daemon stopped.
   *
   * NOTE: QUEUED tasks are intentionally NOT considered orphans — they were
   * never spawned, so they have no executor to recover. The startup queue
   * drainer (see register-routes.ts processNextQueuedTask) picks them up
   * once any session goes idle. See never-lose-prompt §C.
   */
  async findOrphaned(): Promise<Task[]> {
    try {
      const rows = await select(this.db).from(tasks).where(taskTurnHoldingWhere(this.db)).all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find orphaned tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find tasks by status
   */
  async findByStatus(status: Task['status']): Promise<Task[]> {
    try {
      const rows = await select(this.db).from(tasks).where(eq(tasks.status, status)).all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Atomically claim the durable queue head. No caller may choose a later task. */
  async claimNextExecutorTurn(input: {
    sessionId: SessionID;
    patch: Partial<Task> & {
      status: typeof TaskStatus.DISPATCHING | typeof TaskStatus.RUNNING;
    };
  }): Promise<Task | null> {
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, input.sessionId);

        const session = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, input.sessionId))
          .one();
        const active = await select(db, { task_id: tasks.task_id })
          .from(tasks)
          .where(taskTurnHoldingWhere(this.db, input.sessionId))
          .limit(1)
          .one();
        if (!session || session.status === SessionStatus.STOPPING || active) return null;

        const queueHead = await select(db, { task_id: tasks.task_id })
          .from(tasks)
          .where(and(eq(tasks.session_id, input.sessionId), eq(tasks.status, TaskStatus.QUEUED)))
          .orderBy(tasks.queue_position)
          .limit(1)
          .one();
        if (!queueHead) return null;
        const fullId = queueHead.task_id;
        const current = await this.loadLockedTask(db, fullId);
        if (current.status !== TaskStatus.QUEUED) return null;

        const admitted = deepMerge(current, input.patch);
        admitted.executor_attempt = input.patch.executor_attempt;
        admitted.queue_position = undefined;
        const data = this.taskToInsert(admitted);
        await update(db, tasks)
          .set({
            status: data.status,
            queue_position: null,
            started_at: data.started_at,
            data: data.data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();
        await update(db, sessions)
          .set({
            status: SessionStatus.RUNNING,
            ready_for_prompt: false,
            updated_at: new Date(),
            data: {
              ...session.data,
              tasks: session.data.tasks.includes(fullId)
                ? session.data.tasks
                : [...session.data.tasks, fullId],
            },
          })
          .where(eq(sessions.session_id, input.sessionId))
          .run();
        return admitted;
      },
      { sqliteImmediate: true }
    );
  }

  /** Run an executor-originated effect while its unreleased attempt owns the task. */
  async withActiveExecutorAttempt<T>(
    id: string,
    attemptId: string,
    work: (db: Database, task: Task) => Promise<T>
  ): Promise<T | null> {
    const { fullId, task: known } = await this.resolveExisting(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, known.session_id);
        const current = await this.loadLockedTask(db, fullId, id);
        if (current.executor_attempt?.id !== attemptId || current.executor_attempt.released_at)
          return null;
        return work(db, current);
      },
      { sqliteImmediate: true }
    );
  }

  /** Atomically reserve Stop against whichever task currently owns the session turn. */
  async reserveExecutorStop(
    sessionId: SessionID
  ): Promise<{ task: Task | null; transitioned: boolean }> {
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, sessionId);
        const row = await select(db)
          .from(tasks)
          .where(taskTurnHoldingWhere(this.db, sessionId))
          .orderBy(desc(tasks.started_at), desc(tasks.created_at))
          .limit(1)
          .one();

        if (!row) {
          await update(db, sessions)
            .set({ status: SessionStatus.IDLE, ready_for_prompt: true, updated_at: new Date() })
            .where(eq(sessions.session_id, sessionId))
            .run();
          return { task: null, transitioned: false };
        }

        const current = await this.loadLockedTask(db, row.task_id);
        if (!isTaskTurnHolding(current)) return { task: null, transitioned: false };

        const transitioned = !isTerminalTaskStatus(current.status);
        const task: Task = transitioned
          ? {
              ...current,
              ...finalizeTerminalTaskPatch(current, { status: TaskStatus.STOPPED }),
            }
          : current;
        if (transitioned) {
          const data = this.taskToInsert(task);
          await update(db, tasks)
            .set({ status: data.status, completed_at: data.completed_at, data: data.data })
            .where(eq(tasks.task_id, task.task_id))
            .run();
        }

        await update(db, sessions)
          .set({
            status: task.executor_attempt ? SessionStatus.STOPPING : SessionStatus.IDLE,
            ready_for_prompt: !task.executor_attempt,
            updated_at: new Date(),
          })
          .where(eq(sessions.session_id, sessionId))
          .run();
        return { task, transitioned };
      },
      { sqliteImmediate: true }
    );
  }

  /** Authenticated executor connection. Reconnect by the winning attempt is idempotent. */
  async connectExecutor(
    id: string,
    attemptId: string
  ): Promise<{ task: Task; transitioned: boolean } | null> {
    const { fullId, task: known } = await this.resolveExisting(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, known.session_id);
        const current = await this.loadLockedTask(db, fullId, id);
        const session = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, known.session_id))
          .one();
        if (
          session?.status === SessionStatus.STOPPING ||
          current.executor_attempt?.id !== attemptId
        )
          return null;
        if (current.status === TaskStatus.RUNNING && current.executor_connected_at) {
          return { task: current, transitioned: false };
        }
        if (current.status !== TaskStatus.DISPATCHING) return null;

        const connectedAt = new Date();
        const task = {
          ...current,
          status: TaskStatus.RUNNING,
          executor_connected_at: connectedAt.toISOString(),
        } satisfies Task;
        await update(db, tasks)
          .set({ status: task.status, executor_connected_at: connectedAt })
          .where(eq(tasks.task_id, fullId))
          .run();
        await update(db, sessions)
          .set({ status: SessionStatus.RUNNING, ready_for_prompt: false, updated_at: new Date() })
          .where(eq(sessions.session_id, current.session_id))
          .run();
        return { task, transitioned: true };
      },
      { sqliteImmediate: true }
    );
  }

  /** Project an executor runtime state onto its owning session atomically. */
  async transitionExecutorRuntime(
    id: string,
    attemptId: string,
    status:
      | typeof TaskStatus.RUNNING
      | typeof TaskStatus.AWAITING_PERMISSION
      | typeof TaskStatus.AWAITING_INPUT
  ): Promise<Task | null> {
    const { fullId, task: known } = await this.resolveExisting(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, known.session_id);
        const current = await this.loadLockedTask(db, fullId, id);
        const session = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, known.session_id))
          .one();
        if (
          current.executor_attempt?.id !== attemptId ||
          session?.status === SessionStatus.STOPPING ||
          !current.executor_connected_at ||
          isTerminalTaskStatus(current.status)
        ) {
          return null;
        }
        const task = { ...current, status } satisfies Task;
        await update(db, tasks).set({ status }).where(eq(tasks.task_id, fullId)).run();
        await update(db, sessions)
          .set({ status, ready_for_prompt: false, updated_at: new Date() })
          .where(eq(sessions.session_id, current.session_id))
          .run();
        return task;
      },
      { sqliteImmediate: true }
    );
  }

  /** Persist bounded executor telemetry only while the attempt owns an active task. */
  async recordExecutorTelemetry(
    id: string,
    attemptId: string,
    telemetry: Pick<Task, 'last_executor_heartbeat_at' | 'latest_executor_pulse'>
  ): Promise<Task | null> {
    const fullId = await this.resolveId(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        const current = await this.loadLockedTask(db, fullId, id);
        if (
          current.executor_attempt?.id !== attemptId ||
          !current.executor_connected_at ||
          !EXECUTING_TASK_STATUSES.has(current.status) ||
          current.status === TaskStatus.DISPATCHING
        ) {
          return null;
        }
        const task = { ...current, ...telemetry } satisfies Task;
        const data = this.taskToInsert(task);
        await update(db, tasks)
          .set({
            last_executor_heartbeat_at: data.last_executor_heartbeat_at,
            data: data.data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();
        return task;
      },
      { sqliteImmediate: true }
    );
  }

  /** Attempt-fenced metadata used to recover cleanup after daemon restart. */
  async patchExecutorAttempt(
    id: string,
    attemptId: string,
    patch: Partial<NonNullable<Task['executor_attempt']>>
  ): Promise<Task | null> {
    const fullId = await this.resolveId(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        const current = await this.loadLockedTask(db, fullId, id);
        if (current.executor_attempt?.id !== attemptId || current.executor_attempt.released_at) {
          return null;
        }
        const task = {
          ...current,
          executor_attempt: { ...current.executor_attempt, ...patch, id: attemptId },
        } satisfies Task;
        const data = this.taskToInsert(task);
        await update(db, tasks).set({ data: data.data }).where(eq(tasks.task_id, fullId)).run();
        return task;
      },
      { sqliteImmediate: true }
    );
  }

  /** Release admission only after the attempt is terminal and its external effects are settled. */
  async releaseExecutorTurn(
    id: string,
    attemptId: string,
    callback?: CompletionCallbackInput & { disableAfterDelivery?: boolean }
  ): Promise<{ task: Task; released: boolean; callbackTask?: Task } | null> {
    const { fullId, task: known } = await this.resolveExisting(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        const sessionIds = [...new Set([known.session_id, callback?.targetSessionId])]
          .filter((sessionId): sessionId is SessionID => !!sessionId)
          .sort();
        for (const sessionId of sessionIds) await this.lockSession(db, sessionId);
        const current = await this.loadLockedTask(db, fullId, id);
        if (current.executor_attempt?.id !== attemptId || !isTerminalTaskStatus(current.status)) {
          return null;
        }
        if (current.executor_attempt.released_at) return { task: current, released: false };

        const callbackTarget = callback
          ? await select(db)
              .from(sessions)
              .where(eq(sessions.session_id, callback.targetSessionId))
              .one()
          : undefined;
        const enqueued =
          callback && callbackTarget
            ? await this.enqueueCompletionCallback(db, current, callback)
            : undefined;
        const task = {
          ...(enqueued?.source ?? current),
          executor_attempt: {
            ...current.executor_attempt,
            released_at: new Date().toISOString(),
            finalization_error: undefined,
          },
        } satisfies Task;
        const data = this.taskToInsert(task);
        await update(db, tasks).set({ data: data.data }).where(eq(tasks.task_id, fullId)).run();
        const session = callback?.disableAfterDelivery
          ? await select(db).from(sessions).where(eq(sessions.session_id, task.session_id)).one()
          : undefined;
        await update(db, sessions)
          .set({
            status:
              task.status === TaskStatus.FAILED
                ? SessionStatus.FAILED
                : task.status === TaskStatus.TIMED_OUT
                  ? SessionStatus.TIMED_OUT
                  : SessionStatus.IDLE,
            ready_for_prompt: true,
            updated_at: new Date(),
            ...(session
              ? {
                  data: {
                    ...session.data,
                    callback_config: { ...session.data.callback_config, enabled: false },
                  },
                }
              : {}),
          })
          .where(eq(sessions.session_id, task.session_id))
          .run();
        return { task, released: true, callbackTask: enqueued?.callback };
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Update task by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., task status + message_range updates).
   */
  async update(id: string, updates: Partial<Task>): Promise<Task>;
  async update(id: string, updates: Partial<Task>, expectedAttemptId: string): Promise<Task | null>;
  async update(
    id: string,
    updates: Partial<Task>,
    expectedAttemptId?: string
  ): Promise<Task | null> {
    try {
      const fullId = await this.resolveId(id);

      console.debug(
        `🔄 [TaskRepo] Updating task ${shortId(fullId)}${updates.status ? ` (status: ${updates.status})` : ''}`
      );

      const result = await runDatabaseTransaction(
        this.db,
        async (db) => {
          const current = await this.loadLockedTask(db, fullId, id);

          if (
            expectedAttemptId &&
            (current.executor_attempt?.id !== expectedAttemptId ||
              current.executor_attempt.released_at ||
              !current.executor_connected_at ||
              isTerminalTaskStatus(current.status) ||
              (current.status === TaskStatus.STOPPING && updates.status !== TaskStatus.STOPPED))
          ) {
            return null;
          }

          if (
            isTerminalTaskStatus(current.status) &&
            updates.status !== undefined &&
            updates.status !== current.status
          ) {
            throw new RepositoryError(
              `terminal task status cannot be changed from ${current.status}`
            );
          }
          if (
            current.status === TaskStatus.STOPPING &&
            updates.status !== undefined &&
            updates.status !== TaskStatus.STOPPING &&
            updates.status !== TaskStatus.STOPPED
          ) {
            throw new RepositoryError('stopping tasks can only transition to stopped');
          }
          if (current.status === TaskStatus.DISPATCHING && updates.status === TaskStatus.RUNNING) {
            throw new RepositoryError('dispatching tasks must connect through connectExecutor');
          }

          const merged = deepMerge(current, updates);
          if (updates.latest_executor_pulse)
            merged.latest_executor_pulse = updates.latest_executor_pulse;
          const insertData = this.taskToInsert(merged);

          await update(db, tasks)
            .set({
              status: insertData.status,
              queue_position: insertData.queue_position,
              started_at: insertData.started_at,
              executor_connected_at: insertData.executor_connected_at,
              completed_at: insertData.completed_at,
              last_executor_heartbeat_at: insertData.last_executor_heartbeat_at,
              session_md5: insertData.session_md5,
              data: insertData.data,
            })
            .where(eq(tasks.task_id, fullId))
            .run();

          return merged;
        },
        { sqliteImmediate: true }
      );
      return result;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Delete only while the task is pending, serialized against session admission. */
  async removePending(id: string): Promise<Task | null> {
    const { fullId, task: known } = await this.resolveExisting(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, known.session_id);
        const current = await this.loadLockedTask(db, fullId, id);
        if (current.status !== TaskStatus.CREATED && current.status !== TaskStatus.QUEUED) {
          return null;
        }
        await deleteFrom(db, tasks).where(eq(tasks.task_id, fullId)).run();
        return current;
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Delete task by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, tasks).where(eq(tasks.task_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Task', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Durably enqueue a turn before any fallible preparation. Queue position is
   * the submission order and is assigned under the session lock.
   *
   * Sentinel contract: while a task carries `message_range.start_index = -1`
   * and `git_state.sha_at_start = ''`, it has not yet been pinned to real
   * conversation/git state. startClaimedTask is the sole place that
   * overwrites these on the way to RUNNING.
   */
  async createPending(input: {
    session_id: SessionID;
    full_prompt: string;
    created_by: string;
    metadata?: TaskMetadata;
  }): Promise<Task> {
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, input.session_id);
        // Empty message/git sentinels are pinned by startClaimedTask after claim.
        const insertData = this.queuedTaskInsert(
          {
            sessionId: input.session_id,
            fullPrompt: input.full_prompt,
            createdBy: input.created_by,
            metadata: input.metadata,
          },
          await this.nextQueuePosition(db, input.session_id)
        );
        await insert(db, tasks).values(insertData).run();
        const row = await select(db).from(tasks).where(eq(tasks.task_id, insertData.task_id)).one();
        if (!row) throw new RepositoryError('Failed to retrieve created queued task');
        return this.rowToTask(row);
      },
      { sqliteImmediate: true }
    );
  }

  /** Atomically enqueue a completion callback and record its idempotency marker. */
  async createCompletionCallback(input: CompletionCallbackInput): Promise<Task | null> {
    const { fullId, task: known } = await this.resolveExisting(input.sourceTaskId);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        const sessionIds = [...new Set([known.session_id, input.targetSessionId])].sort();
        for (const sessionId of sessionIds) await this.lockSession(db, sessionId);

        const source = await this.loadLockedTask(db, fullId);
        if (
          !isTerminalTaskStatus(source.status) ||
          (source.executor_attempt && !source.executor_attempt.released_at)
        ) {
          throw new RepositoryError('Completion callback source has not settled');
        }
        return (await this.enqueueCompletionCallback(db, source, input))?.callback ?? null;
      },
      { sqliteImmediate: true }
    );
  }

  private async enqueueCompletionCallback(
    db: Database,
    source: Task,
    input: CompletionCallbackInput
  ): Promise<{ source: Task; callback: Task } | null> {
    if (
      source.metadata?.callback_dispatches?.some(
        (dispatch) =>
          dispatch.event === SESSION_COMPLETION_CALLBACK_EVENT &&
          dispatch.target_session_id === input.targetSessionId
      )
    ) {
      return null;
    }
    const callbackData = this.queuedTaskInsert(
      {
        sessionId: input.targetSessionId,
        fullPrompt: input.fullPrompt,
        createdBy: input.createdBy,
        metadata: input.metadata,
      },
      await this.nextQueuePosition(db, input.targetSessionId)
    );
    await insert(db, tasks).values(callbackData).run();
    const callbackRow = await select(db)
      .from(tasks)
      .where(eq(tasks.task_id, callbackData.task_id))
      .one();
    if (!callbackRow) throw new RepositoryError('Failed to retrieve queued completion callback');
    const callback = this.rowToTask(callbackRow);
    const updatedSource = {
      ...source,
      metadata: {
        ...source.metadata,
        callback_dispatches: [
          ...(source.metadata?.callback_dispatches ?? []),
          {
            event: SESSION_COMPLETION_CALLBACK_EVENT,
            target_session_id: input.targetSessionId,
            queued_task_id: callback.task_id,
            dispatched_at: new Date().toISOString(),
          },
        ],
      },
    } satisfies Task;
    await update(db, tasks)
      .set({ data: this.taskToInsert(updatedSource).data })
      .where(eq(tasks.task_id, source.task_id))
      .run();
    return { source: updatedSource, callback };
  }

  /** Move an explicit CREATED draft into the same durable FIFO as every prompt. */
  async enqueueCreatedTask(id: string, metadata?: TaskMetadata): Promise<Task> {
    const { fullId, task: known } = await this.resolveExisting(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, known.session_id);
        const current = await this.loadLockedTask(db, fullId, id);
        if (current.status !== TaskStatus.CREATED) {
          throw new RepositoryError(`Task is not enqueueable (${current.status})`);
        }
        const queued = {
          ...current,
          status: TaskStatus.QUEUED,
          queue_position: await this.nextQueuePosition(db, current.session_id),
          metadata: { ...current.metadata, ...metadata },
        } satisfies Task;
        const data = this.taskToInsert(queued);
        await update(db, tasks)
          .set({ status: data.status, queue_position: data.queue_position, data: data.data })
          .where(eq(tasks.task_id, fullId))
          .run();
        return queued;
      },
      { sqliteImmediate: true }
    );
  }

  private async nextQueuePosition(db: Database, sessionId: SessionID): Promise<number> {
    const row = await select(db, { max: sql<number | null>`max(${tasks.queue_position})` })
      .from(tasks)
      .where(and(eq(tasks.session_id, sessionId), eq(tasks.status, TaskStatus.QUEUED)))
      .one();
    return (row?.max ?? 0) + 1;
  }

  /**
   * Find all QUEUED tasks for a session, ordered by queue_position ascending.
   */
  async findQueued(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
        .orderBy(tasks.queue_position)
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find queued tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Return the next QUEUED task to drain (lowest queue_position) for a session,
   * or null if none.
   */
  async getNextQueued(sessionId: string): Promise<Task | null> {
    try {
      const row = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
        .orderBy(tasks.queue_position)
        .limit(1)
        .one();

      return row ? this.rowToTask(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to get next queued task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Count tasks for a session
   */
  async countBySession(sessionId: string): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
