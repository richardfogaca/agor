import { and, eq } from 'drizzle-orm';
import type {
  AgenticToolConfigField,
  ProviderConnection,
  ProviderConnectionTool,
  UserID,
} from '../../types';
import { TENANT_PROVIDER_CONNECTION_FIELDS as ALLOWED_FIELDS } from '../../types';
import type { Database } from '../client';
import {
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
} from '../database-wrapper';
import { appVariables } from '../schema';
import { getCurrentTenantDatabase } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';

const NAMESPACE = 'provider_connections';

function isAllowedField(tool: ProviderConnectionTool, field: AgenticToolConfigField): boolean {
  return (ALLOWED_FIELDS[tool] as readonly AgenticToolConfigField[]).includes(field);
}

function parseConnection<T extends ProviderConnectionTool>(
  tool: T,
  value: string
): ProviderConnection<T> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid stored provider connection for ${tool}`);
  }

  const allowed = new Set<AgenticToolConfigField>(
    ALLOWED_FIELDS[tool] as readonly AgenticToolConfigField[]
  );
  const connection: Record<string, string> = {};
  for (const [field, fieldValue] of Object.entries(parsed)) {
    if (!allowed.has(field as AgenticToolConfigField) || typeof fieldValue !== 'string') {
      throw new Error(`Invalid stored provider connection field for ${tool}`);
    }
    const normalized = fieldValue.trim();
    if (normalized) connection[field] = normalized;
  }
  return connection as ProviderConnection<T>;
}

/** Typed tenant provider defaults stored as one encrypted app-variable row per tool. */
export class ProviderConnectionRepository {
  private variables: AppVariableRepository;

  constructor(private db: Database) {
    this.variables = new AppVariableRepository(db);
  }

  async find<T extends ProviderConnectionTool>(tool: T): Promise<ProviderConnection<T> | null> {
    const variable = await this.variables.find(NAMESPACE, tool);
    if (!variable) return null;
    const plaintext = await this.variables.getPlain(NAMESPACE, tool);
    return plaintext ? parseConnection(tool, plaintext) : ({} as ProviderConnection<T>);
  }

  async setField<T extends ProviderConnectionTool>(
    tool: T,
    field: AgenticToolConfigField,
    value: string | null,
    updatedBy?: UserID | null
  ): Promise<ProviderConnection<T> | null> {
    const result = await this.patch({ [tool]: { [field]: value } }, updatedBy);
    return (result[tool] as ProviderConnection<T> | null | undefined) ?? null;
  }

  /**
   * Apply a request's provider fields in one transaction. Each logical tool row
   * is created-if-absent then locked before decrypt/merge/write, preventing
   * partial requests and lost concurrent key/endpoint updates.
   */
  async patch(
    updates: Partial<
      Record<ProviderConnectionTool, Partial<Record<AgenticToolConfigField, string | null>>>
    >,
    updatedBy?: UserID | null
  ): Promise<Partial<Record<ProviderConnectionTool, ProviderConnection | null>>> {
    for (const [tool, fields] of Object.entries(updates) as Array<
      [ProviderConnectionTool, Partial<Record<AgenticToolConfigField, string | null>>]
    >) {
      for (const field of Object.keys(fields) as AgenticToolConfigField[]) {
        if (!isAllowedField(tool, field)) {
          throw new Error(`Unsupported provider connection field ${field} for ${tool}`);
        }
      }
    }

    const applyInTransaction = async (txDb: Database) => {
      const variables = new AppVariableRepository(txDb);
      const result: Partial<Record<ProviderConnectionTool, ProviderConnection | null>> = {};
      const entries = (
        Object.entries(updates) as Array<
          [ProviderConnectionTool, Partial<Record<AgenticToolConfigField, string | null>>]
        >
      ).sort(([a], [b]) => a.localeCompare(b));

      for (const [tool, fields] of entries) {
        await variables.setIfAbsent({
          namespace: NAMESPACE,
          key: tool,
          value: '{}',
          encrypted: true,
          content_type: 'application/json',
          updated_by: updatedBy ?? null,
        });
        await lockRowForUpdate(
          txDb,
          this.db,
          appVariables,
          and(eq(appVariables.namespace, NAMESPACE), eq(appVariables.key, tool))
        );

        const plaintext = await variables.getPlain(NAMESPACE, tool);
        const next = {
          ...(plaintext ? parseConnection(tool, plaintext) : {}),
        } as Record<string, string>;
        for (const [field, value] of Object.entries(fields)) {
          const normalized = value?.trim();
          if (normalized) next[field] = normalized;
          else delete next[field];
        }

        if (Object.keys(next).length === 0) {
          await variables.delete(NAMESPACE, tool);
          result[tool] = null;
        } else {
          await variables.set({
            namespace: NAMESPACE,
            key: tool,
            value: JSON.stringify(next),
            encrypted: true,
            content_type: 'application/json',
            updated_by: updatedBy ?? null,
          });
          result[tool] = next as ProviderConnection;
        }
      }
      return result;
    };

    const activeTenantDb = getCurrentTenantDatabase();
    if (activeTenantDb && isPostgresDatabase(activeTenantDb)) {
      return applyInTransaction(activeTenantDb);
    }

    if (isSQLiteDatabase(this.db)) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await runDatabaseTransaction(this.db, applyInTransaction, {
            sqliteImmediate: true,
          });
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code !== 'SQLITE_BUSY' || attempt >= 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
    }
    return runDatabaseTransaction(this.db, applyInTransaction);
  }
}
