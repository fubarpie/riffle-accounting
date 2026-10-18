// SPDX-License-Identifier: AGPL-3.0-or-later
import { parsePort } from "@riffle/shared";
import pg from "pg";
import { loadImportConfig, loadWorkerKeyring } from "./config";
import { createHealthServer } from "./health";
import { consoleLogger } from "./import";
import { ImportScheduler } from "./scheduler";
import { pgConnectionSource } from "./source";

const port = parsePort(process.env["PORT"], 3001);
const server = createHealthServer();

// Fail at startup, not at the first bank sync, when the import is misconfigured.
const importConfig = loadImportConfig();
let pool: pg.Pool | undefined;
let scheduler: ImportScheduler | undefined;

if (importConfig.enabled) {
  const keyring = loadWorkerKeyring();
  // The restricted riffle_app role: RLS stays enforced; the worker never bypasses it.
  pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: importConfig.concurrency + 3 });
  pool.on("error", (err) => consoleLogger.error("idle database client error", { error: err.name }));
  const abort = new AbortController();
  scheduler = new ImportScheduler({
    deps: {
      pool,
      source: pgConnectionSource(pool),
      keyring,
      signal: abort.signal,
      retryMs: importConfig.retryMs,
    },
    config: importConfig,
    abort: () => abort.abort(),
  });
}

server.listen(port, "0.0.0.0", () => {
  console.log(`riffle-worker listening on :${port}`);
  if (scheduler) {
    scheduler.start();
    console.log(`riffle-worker SimpleFIN import enabled (tick ${importConfig.tickMs / 1000}s, concurrency ${importConfig.concurrency})`);
  } else {
    console.log("riffle-worker SimpleFIN import disabled");
  }
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`riffle-worker received ${signal}, shutting down`);
    // Do not hang forever on keep-alive connections or a stuck import.
    setTimeout(() => process.exit(1), importConfig.shutdownGraceMs + 10_000).unref();
    server.close();
    void (scheduler?.stop() ?? Promise.resolve())
      .then(() => pool?.end())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
