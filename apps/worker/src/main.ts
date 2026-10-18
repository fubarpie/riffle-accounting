// SPDX-License-Identifier: AGPL-3.0-or-later
import { parsePort } from "@riffle/shared";
import { createHealthServer } from "./health";

// Phase 0: the worker only proves the deployment wiring. Job processing
// (SimpleFIN sync, statement extraction) arrives in later phases.
const port = parsePort(process.env["PORT"], 3001);
const server = createHealthServer();

server.listen(port, "0.0.0.0", () => {
  console.log(`riffle-worker listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`riffle-worker received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on keep-alive connections.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
