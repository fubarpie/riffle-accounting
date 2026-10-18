// SPDX-License-Identifier: AGPL-3.0-or-later
import { parsePort } from "@riffle/shared";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const port = parsePort(process.env["PORT"], 3000);
  const host = process.env["HOST"] ?? "0.0.0.0";
  const app = await buildApp({ webDist: process.env["WEB_DIST"], logger: true });

  // Graceful shutdown so in-flight requests finish when the container stops.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().then(
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
