// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MembershipRole, listTransactions, withMembership } from "@riffle/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";

/** Listing is read-only: every member, viewers included. */
const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];

const idParams = z.object({ id: z.uuid() });
const date = z.iso.date();

const listQuery = z.object({
  q: z.string().max(200).optional(),
  from: date.optional(),
  to: date.optional(),
  kind: z.enum(["deposit", "withdrawal", "transfer", "journal"]).optional(),
  accountId: z.uuid().optional(),
  status: z.enum(["live", "voided", "all"]).default("live"),
  sort: z.enum(["date", "amount", "description"]).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: "from must not be after to", path: ["from"],
});

export async function transactionRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  app.get("/api/businesses/:id/transactions", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = idParams.parse(request.params);
    const q = listQuery.parse(request.query);
    const { list, currency } = await withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      const cur = await c.query<{ currency: string }>("SELECT currency FROM businesses WHERE id = $1", [id]);
      return { list: await listTransactions(c, id, q), currency: (cur.rows[0]?.currency ?? "").trim() };
    });
    return reply.header("cache-control", "no-store").send({ currency, ...list });
  });
}
