// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type MembershipRole, balanceSheet, generalLedger, profitLoss, taxSummary, trialBalance, withMembership,
} from "@riffle/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import {
  balanceSheetCsv, generalLedgerCsv, profitLossCsv, taxSummaryCsv, trialBalanceCsv,
} from "../report-csv";

/** Reports are read-only: every member, viewers included. */
const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];

const idParams = z.object({ id: z.uuid() });
/** Calendar date, validated for real (rejects 2025-02-30). */
const date = z.iso.date();
const format = z.enum(["json", "csv"]).default("json");

const asOfQuery = z.object({ asOf: date, format });
const rangeQuery = z.object({ from: date, to: date, format }).refine((q) => q.from <= q.to, {
  message: "from must not be after to", path: ["from"],
});
const ledgerQuery = z.object({ from: date, to: date, accountId: z.uuid().optional(), format }).refine(
  (q) => q.from <= q.to, { message: "from must not be after to", path: ["from"] });
const taxQuery = z.object({
  from: date, to: date, format,
  accounts: z.string().transform((s) => s.split(",").filter(Boolean)).pipe(z.array(z.uuid()).max(100)).optional(),
}).refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["from"] });

function sendCsv(reply: FastifyReply, name: string, body: string): FastifyReply {
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${name}.csv"`)
    .header("cache-control", "no-store")
    .send(body);
}

export async function reportRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  /** Shared shape: auth, membership + RLS, then JSON or CSV. */
  function report<Q extends { format: "json" | "csv" }, R>(
    path: string, schema: z.ZodType<Q>, key: string, filename: (q: Q) => string,
    run: (c: Parameters<Parameters<typeof withMembership>[4]>[0], businessId: string, q: Q) => Promise<R>,
    toCsvText: (r: R, currency: string) => string,
  ): void {
    app.get(`/api/businesses/:id/reports/${path}`, async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const { id } = idParams.parse(request.params);
      const q = schema.parse(request.query);
      const { data, currency } = await withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
        const cur = await c.query<{ currency: string }>("SELECT currency FROM businesses WHERE id = $1", [id]);
        return { data: await run(c, id, q), currency: (cur.rows[0]?.currency ?? "").trim() };
      });
      if (q.format === "csv") return sendCsv(reply, filename(q), toCsvText(data, currency));
      return { currency, [key]: data };
    });
  }

  report("trial-balance", asOfQuery, "report", (q) => `trial-balance-${q.asOf}`,
    (c, id, q) => trialBalance(c, id, q.asOf), trialBalanceCsv);
  report("profit-loss", rangeQuery, "report", (q) => `profit-loss-${q.from}_${q.to}`,
    (c, id, q) => profitLoss(c, id, q.from, q.to), profitLossCsv);
  report("balance-sheet", asOfQuery, "report", (q) => `balance-sheet-${q.asOf}`,
    (c, id, q) => balanceSheet(c, id, q.asOf), balanceSheetCsv);
  report("general-ledger", ledgerQuery, "report", (q) => `general-ledger-${q.from}_${q.to}`,
    (c, id, q) => generalLedger(c, id, q.from, q.to, q.accountId), generalLedgerCsv);
  report("tax-summary", taxQuery, "report", (q) => `tax-summary-${q.from}_${q.to}`,
    (c, id, q) => taxSummary(c, id, q.from, q.to, q.accounts), taxSummaryCsv);
}
