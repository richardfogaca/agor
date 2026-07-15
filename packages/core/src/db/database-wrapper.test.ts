import { eq, type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { dateTruncUtc, lockRowForUpdate } from './database-wrapper';
import { tasks } from './schema.postgres';

describe('dateTruncUtc', () => {
  it('inlines validated PostgreSQL bucket units so SELECT/GROUP BY expressions match', () => {
    const fakePostgresDb = {} as Parameters<typeof dateTruncUtc>[0];
    const bucketExpr = dateTruncUtc(fakePostgresDb, tasks.created_at, 'week');
    const query = sql`select ${bucketExpr} as bucket from ${tasks} group by ${bucketExpr}`;

    const rendered = new PgDialect().sqlToQuery(query);

    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain("date_trunc('week'");
    expect(rendered.sql).not.toContain('date_trunc($');
  });
});

it('uses a row lock compatible with earlier foreign-key checks', async () => {
  let query: SQL | undefined;
  const transaction = { execute: async (value: SQL) => (query = value) };

  await lockRowForUpdate(transaction as never, {} as never, tasks, eq(tasks.task_id, 'task-1'));

  expect(new PgDialect().sqlToQuery(query!).sql).toContain('FOR NO KEY UPDATE');
});
