import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { decryptApiKey } from '../db/encryption';
import { ProviderConnectionRepository } from '../db/repositories/provider-connections';
import { users } from '../db/schema';
import type {
  AgenticToolConfigField,
  AgenticToolName,
  ProviderConnection,
  ProviderConnectionTool,
  ProviderCredentialStatus,
  ProviderCredentialStatusSource,
  ResolvedProviderConnection,
  StoredAgenticTools,
  UserID,
} from '../types';
import {
  canonicalProviderConnectionTool,
  PROVIDER_CONNECTION_FIELDS,
  TENANT_PROVIDER_CONNECTION_FIELDS,
} from '../types';
import { loadConfigSync } from './config-manager';
import { normalizeStoredEnvMap, type RawStoredEnvVar } from './env-vars';
import { resolveMultiTenancyConfig } from './multitenancy';
import type { AgorConfig } from './types';

export type ProviderResolutionMode = 'static' | 'required_from_auth';
export const PROVIDER_RESOLUTION_MODE_ENV_VAR = 'AGOR_PROVIDER_RESOLUTION_MODE';

export interface ProviderConnectionResolutionContext {
  userId?: UserID;
  db?: Database;
  mode?: ProviderResolutionMode;
  /** Already-loaded daemon config; primarily avoids a second file read at service boundaries. */
  config?: AgorConfig;
}

const PROVIDER_ENV_KEYS = new Set<string>([
  ...Object.values(PROVIDER_CONNECTION_FIELDS).flat(),
  'GOOGLE_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

function configuredMode(config?: AgorConfig): ProviderResolutionMode {
  return resolveMultiTenancyConfig(config ?? loadConfigSync()).mode;
}

function normalizeConnection<T extends ProviderConnectionTool>(
  tool: T,
  input: Record<string, string | undefined>
): ProviderConnection<T> {
  const out: Record<string, string> = {};
  for (const field of PROVIDER_CONNECTION_FIELDS[tool] as readonly AgenticToolConfigField[]) {
    const value = input[field]?.trim();
    if (value) out[field] = value;
  }
  return out as ProviderConnection<T>;
}

function hasFields(connection: ProviderConnection): boolean {
  return Object.keys(connection).length > 0;
}

async function resolveUserConnection<T extends ProviderConnectionTool>(
  tool: T,
  userId: UserID,
  db: Database
): Promise<{ connection: ProviderConnection<T>; decryptionFailed: boolean } | null> {
  const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
  if (!row) return null;

  const data = row.data as {
    agentic_tools?: StoredAgenticTools;
    env_vars?: Record<string, RawStoredEnvVar>;
  };

  const storedTool = data.agentic_tools?.[tool];
  if (storedTool && Object.keys(storedTool).length > 0) {
    const connection: Record<string, string> = {};
    try {
      for (const field of PROVIDER_CONNECTION_FIELDS[tool] as readonly AgenticToolConfigField[]) {
        const encrypted = storedTool[field];
        if (!encrypted) continue;
        const value = decryptApiKey(encrypted).trim();
        if (value) connection[field] = value;
      }
    } catch {
      return { connection: {} as ProviderConnection<T>, decryptionFailed: true };
    }
    // A stored tool bucket is an atomic override, even when it contains only a
    // custom endpoint. Never combine the endpoint with a tenant/system key.
    return { connection: connection as ProviderConnection<T>, decryptionFailed: false };
  }

  // Compatibility for existing per-user Env Vars. Treat all matching fields
  // as one user-owned connection rather than mixing them with another scope.
  const normalizedEnv = normalizeStoredEnvMap(data.env_vars);
  const legacy: Record<string, string> = {};
  try {
    for (const field of PROVIDER_CONNECTION_FIELDS[tool] as readonly AgenticToolConfigField[]) {
      const entry = normalizedEnv[field];
      if (!entry) continue;
      const value = decryptApiKey(entry.value_encrypted).trim();
      if (value) legacy[field] = value;
    }
    if (tool === 'gemini' && !legacy.GEMINI_API_KEY && normalizedEnv.GOOGLE_API_KEY) {
      legacy.GEMINI_API_KEY = decryptApiKey(normalizedEnv.GOOGLE_API_KEY.value_encrypted).trim();
    }
    if (tool === 'copilot' && !legacy.COPILOT_GITHUB_TOKEN) {
      const alias = normalizedEnv.GH_TOKEN ?? normalizedEnv.GITHUB_TOKEN;
      if (alias) legacy.COPILOT_GITHUB_TOKEN = decryptApiKey(alias.value_encrypted).trim();
    }
  } catch {
    return { connection: {} as ProviderConnection<T>, decryptionFailed: true };
  }
  return hasFields(legacy)
    ? { connection: legacy as ProviderConnection<T>, decryptionFailed: false }
    : null;
}

function resolveSystemConnection<T extends ProviderConnectionTool>(
  tool: T,
  config: AgorConfig
): { connection: ProviderConnection<T>; source: 'config' | 'env' } | null {
  const configured = normalizeConnection(
    tool,
    (config.credentials ?? {}) as Record<string, string | undefined>
  );
  if (hasFields(configured)) return { connection: configured, source: 'config' };

  const systemEnv = process.env as Record<string, string | undefined>;
  const environment = normalizeConnection(tool, systemEnv);
  const environmentFields = environment as Record<string, string | undefined>;
  if (tool === 'gemini' && !environmentFields.GEMINI_API_KEY && systemEnv.GOOGLE_API_KEY) {
    environmentFields.GEMINI_API_KEY = systemEnv.GOOGLE_API_KEY;
  }
  if (tool === 'copilot' && !environmentFields.COPILOT_GITHUB_TOKEN) {
    environmentFields.COPILOT_GITHUB_TOKEN = systemEnv.GH_TOKEN ?? systemEnv.GITHUB_TOKEN;
  }
  return hasFields(environment) ? { connection: environment, source: 'env' } : null;
}

/**
 * Resolve one complete provider connection. The first owning scope wins as a
 * unit so a key from one tenant/user can never be paired with another scope's
 * custom endpoint.
 */
export async function resolveProviderConnection(
  requestedTool: AgenticToolName,
  context: ProviderConnectionResolutionContext = {}
): Promise<ResolvedProviderConnection> {
  const tool = canonicalProviderConnectionTool(requestedTool);
  if (!tool) {
    throw new Error(`Tool ${requestedTool} does not use a provider connection`);
  }

  if (context.userId && context.db) {
    const user = await resolveUserConnection(tool, context.userId, context.db);
    if (user) {
      return {
        tool,
        connection: user.connection,
        source: 'user',
        useNativeAuth: false,
        ...(user.decryptionFailed ? { decryptionFailed: true } : {}),
      };
    }
  }

  if (context.db) {
    const tenant = await new ProviderConnectionRepository(context.db).find(tool);
    if (tenant) {
      return { tool, connection: tenant, source: 'tenant', useNativeAuth: false };
    }
  }

  const mode = context.mode ?? configuredMode(context.config);
  if (mode === 'required_from_auth') {
    return { tool, connection: {}, source: 'none', useNativeAuth: false };
  }

  // Static compatibility is intentionally explicit. If the caller did not
  // inject the daemon's already-loaded config, a missing/unreadable default
  // config is an error rather than a silent switch to shared process auth.
  const config = context.config ?? loadConfigSync();
  const system = resolveSystemConnection(tool, config);
  if (system) {
    return {
      tool,
      connection: system.connection,
      source: system.source,
      useNativeAuth: false,
    };
  }
  return { tool, connection: {}, source: 'none', useNativeAuth: true };
}

function emptyStatus(): ProviderCredentialStatus {
  const status = {} as ProviderCredentialStatus;
  for (const field of Object.values(PROVIDER_CONNECTION_FIELDS).flat()) {
    status[field] = { configured: false, source: 'none' };
  }
  return status;
}

/** Tenant-admin presence/source view. It never returns connection values. */
export async function resolveProviderCredentialStatus(
  db: Database,
  context: Pick<ProviderConnectionResolutionContext, 'mode' | 'config'> = {}
): Promise<ProviderCredentialStatus> {
  const status = emptyStatus();
  const resolvedMode = context.mode ?? configuredMode(context.config);
  const config =
    resolvedMode === 'static' ? (context.config ?? loadConfigSync()) : (context.config ?? {});
  const repository = new ProviderConnectionRepository(db);

  for (const tool of Object.keys(TENANT_PROVIDER_CONNECTION_FIELDS) as ProviderConnectionTool[]) {
    const tenant = await repository.find(tool);
    let connection: ProviderConnection = tenant ?? {};
    let source: ProviderCredentialStatusSource = tenant ? 'tenant' : 'none';
    if (!tenant && resolvedMode === 'static') {
      const system = resolveSystemConnection(tool, config);
      if (system) {
        connection = system.connection;
        source = system.source;
      }
    }
    for (const field of TENANT_PROVIDER_CONNECTION_FIELDS[
      tool
    ] as readonly AgenticToolConfigField[]) {
      if ((connection as Record<string, string | undefined>)[field]) {
        status[field] = { configured: true, source };
      }
    }
  }
  return status;
}

/** Remove provider credentials from a generic child environment. */
export function stripProviderCredentialEnvironment<T extends Record<string, string | undefined>>(
  input: T
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !PROVIDER_ENV_KEYS.has(key)) output[key] = value;
  }
  return output;
}

export function getConfiguredProviderResolutionMode(): ProviderResolutionMode {
  return configuredMode();
}
