// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { type HealthResponse, getVersion } from "@riffle/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authPlugin } from "./auth-plugin";
import { type ApiConfig, configFromEnv } from "./config";
import { installErrorHandler } from "./errors";
import { authRoutes } from "./routes/auth";
import { businessRoutes } from "./routes/businesses";
import { ruleRoutes } from "./routes/rules";
import { reportRoutes } from "./routes/reports";

export interface AppOptions {
  /** Directory containing the built web UI. When absent, only the API is served. */
  webDist?: string | undefined;
  /** Enable Fastify's request logging. */
  logger?: boolean;
  /** Build version reported by /healthz. */
  version?: string;
  /** Application database pool (role riffle_app). Without it only /healthz and the web UI are served. */
  pool?: Pool | undefined;
  config?: ApiConfig | undefined;
}

/**
 * Build the Fastify application. Kept separate from main.ts so tests can use
 * `app.inject()` without opening a socket.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const version = options.version ?? getVersion();

  app.get("/healthz", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "riffle-api",
    version,
  }));

  installErrorHandler(app);
  if (options.pool) {
    const config = options.config ?? configFromEnv();
    // Called directly (not app.register) so its hooks apply to every route.
    await authPlugin(app, { pool: options.pool, config });
    await app.register(authRoutes, { pool: options.pool, config });
    await app.register(businessRoutes, { pool: options.pool });
    await app.register(ruleRoutes, { pool: options.pool });
    await app.register(reportRoutes, { pool: options.pool });
  }

  const webDist = options.webDist;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });

    // SPA fallback: unknown GET routes that are not API routes get index.html
    // so client-side routing works on refresh.
    app.setNotFoundHandler((request, reply) => {
      const isApiPath = request.url.startsWith("/api/") || request.url === "/healthz";
      if (request.method === "GET" && !isApiPath) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
