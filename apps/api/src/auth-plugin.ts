// SPDX-License-Identifier: AGPL-3.0-or-later
import fastifyCookie from "@fastify/cookie";
import { resolveSession } from "@riffle/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { ApiConfig } from "./config";

export const SESSION_COOKIE = "riffle_session";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function setSessionCookie(reply: FastifyReply, cfg: ApiConfig, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.secureCookies,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, cfg: ApiConfig): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.secureCookies });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Registers cookie parsing, resolves the session on every request, and
 * applies CSRF defence for state-changing requests:
 *  - SameSite=Lax cookies (set above), and
 *  - an Origin check: when a browser sends Origin, it must match the Host
 *    (or a configured trusted origin).
 */
export async function authPlugin(app: FastifyInstance, opts: { pool: Pool; config: ApiConfig }): Promise<void> {
  await app.register(fastifyCookie);
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== "null") {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          host = undefined;
        }
        const ok = host === request.headers.host || opts.config.trustedOrigins.includes(origin);
        if (!ok) return reply.code(403).send({ error: "Cross-origin request refused" });
      } else if (origin === "null") {
        return reply.code(403).send({ error: "Cross-origin request refused" });
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await resolveSession(opts.pool, token);
    if (!session) {
      clearSessionCookie(reply, opts.config);
      return;
    }
    request.user = session.user;
    if (session.refreshed) setSessionCookie(reply, opts.config, token, session.expiresAt);
  });
}

/** Route guard: 401 unless a valid session is present. Returns the user for convenience. */
export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthUser | undefined {
  if (!request.user) {
    void reply.code(401).send({ error: "Authentication required" });
    return undefined;
  }
  return request.user;
}
