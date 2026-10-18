import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema.js';
import { admin, closePools } from './helpers.js';

afterAll(closePools);

describe('drizzle schema matches the migrated database', () => {
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

  it.each(tables.map((t) => [getTableName(t), t] as const))('%s columns agree', async (name, table) => {
    const { rows } = await admin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`, [name]);
    const db = new Map(rows.map((r) => [r.column_name, r.is_nullable === 'NO']));
    const orm = new Map(Object.values(getTableColumns(table)).map((c) => [c.name, c.notNull]));
    expect([...orm.keys()].sort()).toEqual([...db.keys()].sort());
    for (const [col, notNull] of orm) expect(notNull, `${name}.${col} nullability`).toBe(db.get(col));
  });
});
