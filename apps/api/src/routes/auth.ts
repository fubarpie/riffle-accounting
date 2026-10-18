// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EmailTakenError, countUsers, createSession, createUser, deleteSession, findUserByEmail, normalizeEmail,
} from "@riffle/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { SESSION_COOKIE, clearSessionCookie, requireUser, setSessionCookie } from "../auth-plugin";
import type { ApiConfig } from "../config";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, dummyHash, hashPassword, verifyPassword } from "../password";
import { FailureLimiter } from "../rate-limit";

const registerBody = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
const loginBody = z.object({
  email: z.string().max(254),
  password: z.string().max(MAX_PASSWORD_LENGTH),
});

export async function authRoutes(app: FastifyInstance, opts: { pool: Pool; config: ApiConfig }): Promise<void> {
  const { pool, config } = opts;
  // Failures are counted per client IP and per account, so one attacker cannot
  // lock out everyone, and one account cannot be sprayed from many IPs.
  const byIp = new FailureLimiter(20, 15 * 60_000);
  const byEmail = new FailureLimiter(8, 15 * 60_000);

  async function startSession(request: { headers: Record<string, unknown> }, reply: Parameters<typeof setSessionCookie>[0], userId: string) {
    const ua = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined;
    const { token, expiresAt } = await createSession(pool, userId, ua);
    setSessionCookie(reply, config, token, expiresAt);
  }

  app.post("/api/auth/register", async (request, reply) => {
    const body = registerBody.parse(request.body);
    if (!config.allowRegistration && (await countUsers(pool)) > 0) {
      return reply.code(403).send({ error: "Registration is closed" });
    }
    try {
      const user = await createUser(pool, {
        email: body.email, name: body.name, passwordHash: await hashPassword(body.password),
      });
      await startSession(request, reply, user.id);
      return reply.code(201).send({ user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      if (err instanceof EmailTakenError) return reply.code(409).send({ error: "Email already registered" });
      throw err;
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const email = normalizeEmail(body.email);
    if (byIp.isBlocked(request.ip) || byEmail.isBlocked(email)) {
      return reply.code(429).header("retry-after", "900").send({ error: "Too many failed attempts; try again later" });
    }
    const user = await findUserByEmail(pool, email);
    // Always spend one scrypt verification so response time does not reveal
    // whether the account exists.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !user.passwordHash || !ok) {
      byIp.recordFailure(request.ip);
      byEmail.recordFailure(email);
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    byEmail.reset(email);
    await startSession(request, reply, user.id);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(pool, token);
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return { user };
  });
}
