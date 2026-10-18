import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// RIFFLE_MIGRATIONS_DIR lets the bundled server (whose files live elsewhere) find the SQL.
const MIGRATIONS_DIR = process.env.RIFFLE_MIGRATIONS_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Apply pending SQL migrations in filename order, each in its own transaction.
 * Must run as the table-owner role, never as the application role. A
 * session-level advisory lock stops two replicas migrating concurrently.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

/**
 * Give the restricted application role a login password. Run as the owner
 * after migrating. ALTER ROLE cannot take bind parameters, so the literal is
 * escaped by the driver.
 */
export async function setAppRolePassword(pool: Pool, password: string): Promise<void> {
  if (password.length < 16) throw new Error('application role password must be at least 16 characters');
  const client = await pool.connect();
  try {
    await client.query(`ALTER ROLE riffle_app LOGIN PASSWORD ${client.escapeLiteral(password)}`);
  } finally {
    client.release();
  }
}
