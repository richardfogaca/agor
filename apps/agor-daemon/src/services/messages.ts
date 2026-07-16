/**
 * Messages Service
 *
 * Provides REST + WebSocket API for message management.
 * Uses DrizzleService adapter with MessagesRepository.
 */

import { PAGINATION } from '@agor/core/config';
import {
  type Database,
  MessagesRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Conflict } from '@agor/core/feathers';
import type {
  Message,
  MessageID,
  Paginated,
  QueryParams,
  SessionID,
  TaskID,
  UUID,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';

/**
 * Message service params
 */
export type MessageParams = QueryParams<{
  session_id?: SessionID;
  task_id?: TaskID;
  type?: Message['type'];
  role?: Message['role'];
}> & {
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlSessionAccessUserId?: UUID;
  executorAttemptId?: string;
  executorTaskId?: string;
};

/**
 * Extended messages service with custom methods
 */
export class MessagesService extends DrizzleService<Message, Partial<Message>, MessageParams> {
  private messagesRepo: MessagesRepository;
  private taskRepo: TaskRepository;

  constructor(private db: TenantScopeAwareDatabase) {
    const messagesRepo = new MessagesRepository(db);
    super(messagesRepo, {
      id: 'message_id',
      resourceType: 'Message',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['create', 'remove'], // Allow bulk creates and removes
    });

    this.messagesRepo = messagesRepo;
    this.taskRepo = new TaskRepository(db);
  }

  private async withExecutorAttempt<T>(
    params: MessageParams | undefined,
    work: (db: Database) => Promise<T>
  ): Promise<T> {
    if (!params?.executorAttemptId) return work(this.db);
    if (!params.executorTaskId) throw new Conflict('Executor transcript scope is incomplete');
    const result = await this.taskRepo.withActiveExecutorAttempt(
      params.executorTaskId,
      params.executorAttemptId,
      work
    );
    if (result === null) throw new Conflict('Executor attempt no longer owns transcript writes');
    return result;
  }

  override async create(
    data: Partial<Message> | Partial<Message>[],
    params?: MessageParams
  ): Promise<Message | Message[]> {
    if (!params?.executorAttemptId) return super.create(data, params);
    return this.withExecutorAttempt(params, async (db) => {
      const repo = new MessagesRepository(db);
      return Array.isArray(data)
        ? repo.createMany(data as Message[])
        : repo.create(data as Message);
    });
  }

  override async patch(
    id: string | null,
    data: Partial<Message>,
    params?: MessageParams
  ): Promise<Message | Message[]> {
    if (!params?.executorAttemptId) return super.patch(id, data, params);
    if (!id) throw new Conflict('Executor transcript patches require a message ID');
    return this.withExecutorAttempt(params, async (db) => {
      const repo = new MessagesRepository(db);
      const existing = await repo.findById(id as MessageID);
      if (!existing || existing.task_id !== params.executorTaskId) {
        throw new Conflict('Executor attempt does not own this message');
      }
      return repo.update(id, data);
    });
  }

  protected async fetchData(query: Query, params?: MessageParams): Promise<Message[]> {
    const sessionId = query.session_id;
    const filter: Parameters<MessagesRepository['findAll']>[0] = {};

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
    if (typeof query.task_id === 'string') filter.taskId = query.task_id as TaskID;
    if (typeof query.type === 'string') filter.type = query.type as Message['type'];
    if (typeof query.role === 'string') filter.role = query.role as Message['role'];
    if (params?._agorSqlSessionAccessUserId) {
      filter.visibleToUserId = params._agorSqlSessionAccessUserId;
    }

    return this.messagesRepo.findAll(filter);
  }

  /**
   * Override find to support task-based and session-based filtering
   */
  async find(params?: MessageParams): Promise<Message[] | Paginated<Message>> {
    if (params?._agorSqlSessionAccessUserId) {
      return super.find(params);
    }

    // If filtering by task_id (scalar string), use repository method.
    // The RBAC scoping hook may also inject `session_id` (scalar or `$in`)
    // alongside a user-supplied `task_id`; without intersecting here, callers
    // with only `task_id` would bypass branch scoping. Filter the task_id
    // rows by the accessible session_id set before returning.
    if (typeof params?.query?.task_id === 'string') {
      let messages = await this.messagesRepo.findByTaskId(params.query.task_id);

      const sid = params.query.session_id;
      if (typeof sid === 'string') {
        messages = messages.filter((m) => m.session_id === sid);
      } else if (sid && typeof sid === 'object' && Array.isArray((sid as { $in?: unknown }).$in)) {
        const allowed = new Set((sid as { $in: string[] }).$in);
        messages = messages.filter((m) => allowed.has(m.session_id as string));
      }

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 100;
        const skip = params.query.$skip ?? 0;

        return {
          total: messages.length,
          limit,
          skip,
          data: messages.slice(skip, skip + limit),
        };
      }

      return messages;
    }

    // If filtering by session_id as a scalar string, use repository shortcut.
    // A `$in` object (from the RBAC scoping hook) falls through to `super.find`
    // where the adapter's `filterData` handles $in natively.
    if (typeof params?.query?.session_id === 'string') {
      // Use type-filtered query when type is specified (e.g., 'permission_request')
      const messages = params.query.type
        ? await this.messagesRepo.findBySessionIdAndType(params.query.session_id, params.query.type)
        : await this.messagesRepo.findBySessionId(params.query.session_id);

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 100;
        const skip = params.query.$skip ?? 0;

        return {
          total: messages.length,
          limit,
          skip,
          data: messages.slice(skip, skip + limit),
        };
      }

      return messages;
    }

    // Otherwise use default find
    return super.find(params);
  }

  /**
   * Custom method: Get messages by session
   */
  async findBySession(sessionId: SessionID): Promise<Message[]> {
    return this.messagesRepo.findBySessionId(sessionId);
  }

  /**
   * Custom method: Get messages by task
   */
  async findByTask(taskId: TaskID): Promise<Message[]> {
    return this.messagesRepo.findByTaskId(taskId);
  }

  /**
   * Internal helper for auth/scope checks that need to validate the current
   * owner fields of a message before allowing a partial update.
   */
  async findByIdForScopeCheck(messageId: MessageID): Promise<Message | null> {
    return this.messagesRepo.findById(messageId);
  }

  /**
   * Custom method: Get messages in a range
   */
  async findByRange(
    sessionId: SessionID,
    startIndex: number,
    endIndex: number
  ): Promise<Message[]> {
    return this.messagesRepo.findByRange(sessionId, startIndex, endIndex);
  }

  /**
   * Custom method: Bulk insert messages
   */
  async createMany(messages: Message[], params?: MessageParams): Promise<Message[]> {
    if (!params?.executorAttemptId) return this.messagesRepo.createMany(messages);
    return this.withExecutorAttempt(params, (db) =>
      new MessagesRepository(db).createMany(messages)
    );
  }
}

/**
 * Service factory function
 */
export function createMessagesService(db: TenantScopeAwareDatabase): MessagesService {
  return new MessagesService(db);
}
