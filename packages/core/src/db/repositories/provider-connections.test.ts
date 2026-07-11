import { beforeAll, expect } from 'vitest';
import { select } from '../database-wrapper';
import { appVariables } from '../schema';
import { dbTest } from '../test-helpers';
import { ProviderConnectionRepository } from './provider-connections';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'provider-connection-repository-test-secret';
});

dbTest(
  'stores one encrypted provider connection and never persists the canary as plaintext',
  async ({ db }) => {
    const repository = new ProviderConnectionRepository(db);
    const canary = 'tenant-a-openai-canary';

    await repository.setField('codex', 'OPENAI_API_KEY', canary);
    await repository.setField('codex', 'OPENAI_BASE_URL', 'https://tenant-a.example/v1');

    expect(await repository.find('codex')).toEqual({
      OPENAI_API_KEY: canary,
      OPENAI_BASE_URL: 'https://tenant-a.example/v1',
    });

    const rows = await select(db).from(appVariables).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].namespace).toBe('provider_connections');
    expect(rows[0].key).toBe('codex');
    expect(rows[0].is_encrypted).toBe(true);
    expect(rows[0].value_text).toBeNull();
    expect(rows[0].value_encrypted).not.toContain(canary);
  }
);

dbTest('rejects fields outside the strict tenant provider contract', async ({ db }) => {
  const repository = new ProviderConnectionRepository(db);

  await expect(
    repository.setField('claude-code', 'CLAUDE_CODE_OAUTH_TOKEN', 'user-only-token')
  ).rejects.toThrow(/Unsupported provider connection field/);
});

dbTest('deletes the provider row after the last field is cleared', async ({ db }) => {
  const repository = new ProviderConnectionRepository(db);
  await repository.setField('gemini', 'GEMINI_API_KEY', 'gemini-canary');
  await repository.setField('gemini', 'GEMINI_API_KEY', null);

  expect(await repository.find('gemini')).toBeNull();
  expect(await select(db).from(appVariables).all()).toEqual([]);
});

dbTest('merges concurrent key and endpoint updates without losing either field', async ({ db }) => {
  const first = new ProviderConnectionRepository(db);
  const second = new ProviderConnectionRepository(db);

  await Promise.all([
    first.patch({ codex: { OPENAI_API_KEY: 'concurrent-key-canary' } }),
    second.patch({ codex: { OPENAI_BASE_URL: 'https://concurrent.invalid/v1' } }),
  ]);

  expect(await first.find('codex')).toEqual({
    OPENAI_API_KEY: 'concurrent-key-canary',
    OPENAI_BASE_URL: 'https://concurrent.invalid/v1',
  });
});

dbTest('rejects a mixed invalid patch before writing any provider row', async ({ db }) => {
  const repository = new ProviderConnectionRepository(db);

  await expect(
    repository.patch({
      codex: { OPENAI_API_KEY: 'must-not-persist' },
      'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'invalid-tenant-token' },
    })
  ).rejects.toThrow(/Unsupported provider connection field/);

  expect(await repository.find('codex')).toBeNull();
});
