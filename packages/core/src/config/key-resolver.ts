import type { Database } from '../db/client';
import { shortId } from '../lib/ids';
import type {
  AgenticToolName,
  ApiKeyName,
  ProviderConnection,
  ProviderConnectionTool,
  UserID,
} from '../types';
import { canonicalProviderConnectionTool, providerToolForField } from '../types';
import { getCredential, isConfigCredentialKey } from './config-manager';
import {
  getConfiguredProviderResolutionMode,
  resolveProviderConnection,
} from './provider-connection-resolver';

// ApiKeyName is defined in @agor/core/types so it is accessible to the browser
// bundle and executor without a config→types circular dependency.
export type { ApiKeyName } from '../types';

const DEBUG_KEY_RESOLUTION =
  process.env.AGOR_DEBUG_KEY_RESOLUTION === '1' || process.env.DEBUG?.includes('key-resolution');

function debugKeyResolution(message: string): void {
  if (DEBUG_KEY_RESOLUTION) console.debug(message);
}

export interface KeyResolutionContext {
  userId?: UserID;
  db?: Database;
  tool?: AgenticToolName;
  mode?: 'static' | 'required_from_auth';
  config?: import('./types').AgorConfig;
}

export interface KeyResolutionResult {
  apiKey: string | undefined;
  source: 'user' | 'tenant' | 'config' | 'env' | 'none';
  useNativeAuth: boolean;
  /** Complete same-scope snapshot used to pair credentials with endpoints. */
  connection?: ProviderConnection;
  tool?: ProviderConnectionTool;
  decryptionFailed?: boolean;
}

/**
 * Compatibility facade over the atomic provider-connection resolver. Callers
 * receive one requested credential, while its key and endpoint were selected
 * together from a single user/tenant/system scope.
 */
export async function resolveApiKey(
  keyName: ApiKeyName,
  context: KeyResolutionContext = {}
): Promise<KeyResolutionResult> {
  const inferredTool = providerToolForField(keyName);
  const requestedTool = context.tool ? canonicalProviderConnectionTool(context.tool) : inferredTool;

  debugKeyResolution(
    `[API Key Resolution] ${keyName} user=${context.userId ? shortId(context.userId) : 'none'} tool=${requestedTool ?? 'none'}`
  );

  if (!requestedTool || (inferredTool && requestedTool !== inferredTool)) {
    return { apiKey: undefined, source: 'none', useNativeAuth: false };
  }

  const resolved = await resolveProviderConnection(requestedTool, context);
  const apiKey = (resolved.connection as Record<string, string | undefined>)[keyName];
  return {
    apiKey,
    source: resolved.source,
    useNativeAuth: resolved.useNativeAuth,
    connection: resolved.connection,
    tool: resolved.tool,
    ...(resolved.decryptionFailed ? { decryptionFailed: true } : {}),
  };
}

/**
 * Synchronous compatibility for non-database startup callers. Hosted mode
 * fails closed; static mode preserves the legacy config/env/native behavior.
 * Runtime consumers use resolveApiKey/resolveProviderConnection instead.
 */
export function resolveApiKeySync(keyName: ApiKeyName): KeyResolutionResult {
  if (getConfiguredProviderResolutionMode() === 'required_from_auth') {
    return { apiKey: undefined, source: 'none', useNativeAuth: false };
  }
  if (isConfigCredentialKey(keyName)) {
    const value = getCredential(keyName);
    if (value) {
      return {
        apiKey: value,
        source: process.env[keyName] === value ? 'env' : 'config',
        useNativeAuth: false,
      };
    }
  }
  const envKey = process.env[keyName];
  if (envKey) return { apiKey: envKey, source: 'env', useNativeAuth: false };
  return { apiKey: undefined, source: 'none', useNativeAuth: true };
}
