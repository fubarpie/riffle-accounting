// SPDX-License-Identifier: AGPL-3.0-or-later
import { parsePort } from "@riffle/shared";
import { migrate, setAppRolePassword } from "@riffle/db";
import pg from "pg";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const port = parsePort(process.env["PORT"], 3000);
  const host = process.env["HOST"] ?? "0.0.0.0";

  // Migrations need the owner role; the running app uses the restricted riffle_app role.
  const migrateUrl = process.env["MIGRATE_DATABASE_URL"];
  if (migrateUrl) {
    const owner = new pg.Pool({ connectionString: migrateUrl, max: 1 });
    try {
      const applied = await migrate(owner);
      if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
      const appPassword = process.env["APP_DB_PASSWORD"];
      if (appPassword) await setAppRolePassword(owner, appPassword);
    } finally {
      await owner.end();
    }
  }
  const databaseUrl = process.env["DATABASE_URL"];
  const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 10 }) : undefined;
  const app = await buildApp({ webDist: process.env["WEB_DIST"], logger: true, pool });

  // Graceful shutdown so in-flight requests finish when the container stops.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().then(() => pool?.end()).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen({ port, host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
