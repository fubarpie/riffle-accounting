// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Server, createServer } from "node:http";
import { type HealthResponse, getVersion } from "@riffle/shared";

/**
 * Minimal HTTP server exposing /healthz for container orchestrators.
 * The worker has no public API; this is only for liveness checks.
 */
export function createHealthServer(version: string = getVersion()): Server {
  const body: HealthResponse = { status: "ok", service: "riffle-worker", version };
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
}
