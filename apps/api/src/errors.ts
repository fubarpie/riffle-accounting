// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenError, LedgerInputError, NotAMemberError } from "@riffle/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export class Conflict extends Error {}
export class NotFound extends Error {}
export class Refused extends Error {}

type AppError = Error & { code?: string; statusCode?: number };

/** One place that maps domain errors to HTTP responses, for every route. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: AppError, request, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    // "Not a member" and "no such business" look identical, so ids cannot be probed.
    if (err instanceof NotAMemberError || err instanceof NotFound) return reply.code(404).send({ error: "Not found" });
    if (err instanceof ForbiddenError || err instanceof Refused) return reply.code(403).send({ error: "Forbidden" });
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });
    if (err instanceof LedgerInputError) return reply.code(422).send({ error: err.message });
    if (err.code === "23514") return reply.code(409).send({ error: "A business must keep at least one owner" });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "Internal server error" });
  });
}
