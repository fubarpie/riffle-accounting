// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BankInputError, BooksLockedError, ConnectionDisabledError, ForbiddenError, LedgerInputError,
  ExtractionInputError, ExtractionStateError, ImportInputError, ImportStateError,
  NotAMemberError, NotFoundError as DbNotFoundError, ReconciliationInputError, ReconciliationStateError,
  RuleValidationError, StagedStateError,
} from "@riffle/db";
import { ExtractorError } from "@riffle/extractor";
import {
  SimpleFinAccessRevokedError, SimpleFinClaimError, SimpleFinError, SimpleFinInputError,
  SimpleFinRateLimitedError, SimpleFinTokenError,
} from "@riffle/simplefin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export class Conflict extends Error {}
export class NotFound extends Error {}
export class Refused extends Error {}
export class Unavailable extends Error {}
/** Too soon to call the bank again. */
export class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number, message = "Too soon to import again") {
    super(message);
  }
}

type AppError = Error & { code?: string; statusCode?: number };

/** One place that maps domain errors to HTTP responses, for every route. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: AppError, request, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err instanceof RuleValidationError) return reply.code(400).send({ error: "Invalid rule", issues: err.issues });
    // "Not a member" and "no such business" look identical, so ids cannot be probed.
    if (err instanceof NotAMemberError || err instanceof NotFound) return reply.code(404).send({ error: "Not found" });
    if (err instanceof ForbiddenError || err instanceof Refused) return reply.code(403).send({ error: "Forbidden" });
    if (err instanceof DbNotFoundError) return reply.code(404).send({ error: "Not found" });
    if (err instanceof RateLimited) {
      return reply.code(429).header("Retry-After", String(err.retryAfterSeconds))
        .send({ error: err.message, retryAfterSeconds: err.retryAfterSeconds });
    }
    if (err instanceof SimpleFinRateLimitedError) {
      const s = (err as SimpleFinRateLimitedError).retryAfterSeconds ?? 3600;
      return reply.code(429).header("Retry-After", String(s)).send({ error: err.message, retryAfterSeconds: s });
    }
    if (err instanceof Unavailable) return reply.code(503).send({ error: err.message });
    if (err instanceof BankInputError) return reply.code(422).send({ error: err.message });
    if (err instanceof ExtractionInputError) return reply.code(422).send({ error: err.message });
    if (err instanceof ExtractionStateError) return reply.code(409).send({ error: err.message });
    if (err instanceof ImportInputError) return reply.code(422).send({ error: err.message });
    if (err instanceof ImportStateError) return reply.code(409).send({ error: err.message });
    if (err instanceof ExtractorError) {
      // Messages are written by the extractor package and never contain URLs, keys or statement text.
      const status = err.code === "input" ? 422 : err.code === "not_configured" ? 503 : 502;
      return reply.code(status).send({ error: err.message });
    }
    if (err instanceof ReconciliationInputError) return reply.code(422).send({ error: err.message });
    if (err instanceof ReconciliationStateError) return reply.code(409).send({ error: err.message });
    if (err instanceof StagedStateError || err instanceof ConnectionDisabledError) {
      return reply.code(409).send({ error: err.message });
    }
    if (err instanceof BooksLockedError) return reply.code(409).send({ error: err.message });
    if (err instanceof SimpleFinTokenError) return reply.code(400).send({ error: err.message });
    if (err instanceof SimpleFinClaimError || err instanceof SimpleFinInputError) {
      return reply.code(422).send({ error: err.message });
    }
    // Remaining SimpleFIN failures (revoked, timeout, bad response): the bank is the problem, not the client.
    // Their messages never contain credentials, so they are safe to show.
    if (err instanceof SimpleFinAccessRevokedError || err instanceof SimpleFinError) {
      return reply.code(502).send({ error: err.message });
    }
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });
    if (err instanceof LedgerInputError) return reply.code(422).send({ error: err.message });
    // Immutability guards (lock date, reconciled lines, finalised reconciliations).
    if (err.code === "55000") return reply.code(409).send({ error: "Refused: the record is locked or already finalised" });
    if (err.code === "23514") return reply.code(409).send({ error: "A business must keep at least one owner" });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "Internal server error" });
  });
}
