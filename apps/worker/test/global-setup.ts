import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '@riffle/db';

/**
 * Tests run against real PostgreSQL. In CI, point TEST_DATABASE_URL at the
 * service container (superuser URL). Locally, an embedded PostgreSQL is
 * started in a temp dir. Either way: migrate as the owner, then give the
 * `riffle_app` role a login so tests connect exactly like production.
 */
export default async function setup(): Promise<() => Promise<void>> {
  let stop: () => Promise<void> = async () => undefined;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(join(tmpdir(), 'riffle-pg-'));
    const port = 54000 + Math.floor(Math.random() * 1000);
    const server = new EmbeddedPostgres({
      databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false,
      onLog: () => undefined, onError: () => undefined,
    });
    await server.initialise();
    await server.start();
    await server.createDatabase('riffle_test');
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/riffle_test`;
    stop = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  await migrate(admin);
  await admin.query(`ALTER ROLE riffle_app LOGIN PASSWORD 'riffle_app_test'`);
  await admin.end();

  const u = new URL(adminUrl);
  u.username = 'riffle_app';
  u.password = 'riffle_app_test';
  process.env.TEST_ADMIN_URL = adminUrl;
  process.env.TEST_APP_URL = u.toString();

  return async () => {
    await stop();
  };
}
