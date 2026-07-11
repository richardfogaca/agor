import type { AgenticToolName } from './agentic-tool';
import type { AgenticToolConfigField, AgenticToolsConfig } from './user';

/** Agentic tools backed by a provider credential/endpoint connection. */
export type ProviderConnectionTool = Exclude<AgenticToolName, 'claude-code-cli' | 'opencode'>;

export type ProviderConnection<T extends ProviderConnectionTool = ProviderConnectionTool> = Partial<
  NonNullable<AgenticToolsConfig[T]>
>;

export type ProviderConnectionSource = 'user' | 'tenant' | 'config' | 'env' | 'none';

export interface ResolvedProviderConnection<
  T extends ProviderConnectionTool = ProviderConnectionTool,
> {
  tool: T;
  connection: ProviderConnection<T>;
  source: ProviderConnectionSource;
  useNativeAuth: boolean;
  decryptionFailed?: boolean;
}

export type ProviderCredentialStatusSource = Exclude<ProviderConnectionSource, 'user'>;

export interface ProviderCredentialFieldStatus {
  configured: boolean;
  source: ProviderCredentialStatusSource;
}

/** Presence/source-only compatibility projection used by the admin config UI/API. */
export type ProviderCredentialStatus = Record<
  AgenticToolConfigField,
  ProviderCredentialFieldStatus
>;

export const PROVIDER_CONNECTION_FIELDS = {
  'claude-code': [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  gemini: ['GEMINI_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN'],
  cursor: ['CURSOR_API_KEY'],
} as const satisfies Record<ProviderConnectionTool, readonly AgenticToolConfigField[]>;

/** Tenant administrators may store provider defaults, but not a user's subscription token. */
export const TENANT_PROVIDER_CONNECTION_FIELDS = {
  ...PROVIDER_CONNECTION_FIELDS,
  'claude-code': PROVIDER_CONNECTION_FIELDS['claude-code'].filter(
    (field) => field !== 'CLAUDE_CODE_OAUTH_TOKEN'
  ),
} as const satisfies Record<ProviderConnectionTool, readonly AgenticToolConfigField[]>;

export function canonicalProviderConnectionTool(
  tool: AgenticToolName
): ProviderConnectionTool | null {
  if (tool === 'claude-code-cli') return 'claude-code';
  if (tool === 'opencode') return null;
  return tool;
}

export function providerToolForField(field: AgenticToolConfigField): ProviderConnectionTool | null {
  for (const [tool, fields] of Object.entries(PROVIDER_CONNECTION_FIELDS) as Array<
    [ProviderConnectionTool, readonly AgenticToolConfigField[]]
  >) {
    if (fields.includes(field)) return tool;
  }
  return null;
}
