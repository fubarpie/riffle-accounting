// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  RULE_WRITER_ROLES, RuleValidationError, applyRules, createRule, deleteRule, getRule, listRules,
  parseRuleDefinition, previewRules, toEvaluable, updateRule, withMembership, isIsoDate,
  MAX_SCAN_LIMIT, type EvaluableRule, type MembershipRole,
} from "@riffle/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import { NotFound } from "../errors";

/** Everyone in the business may read rules and preview them; only writers change anything. */
const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];

const bizParams = z.object({ id: z.uuid() });
const ruleParams = z.object({ id: z.uuid(), ruleId: z.uuid() });

const isoDate = z.string().refine(isIsoDate, "must be a valid YYYY-MM-DD date");
const scope = {
  transactionIds: z.array(z.uuid()).min(1).max(MAX_SCAN_LIMIT).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.number().int().min(1).max(MAX_SCAN_LIMIT).optional(),
};
const applyBody = z.object(scope).strict();
const dryRunBody = z.object({
  ...scope,
  /** Optional unsaved drafts to test instead of the stored rules. */
  rules: z.array(z.unknown()).min(1).max(50).optional(),
}).strict();

export async function ruleRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  app.get("/api/businesses/:id/rules", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => ({ rules: await listRules(c, id) }));
  });

  app.get("/api/businesses/:id/rules/:ruleId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, ruleId } = ruleParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      const rule = await getRule(c, id, ruleId);
      if (!rule) throw new NotFound();
      return { rule };
    });
  });

  app.post("/api/businesses/:id/rules", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    // Role is checked before the body is examined, so a viewer learns nothing about validation.
    const rule = await withMembership(pool, user.id, id, RULE_WRITER_ROLES, async (c) =>
      createRule(c, id, user.id, parseRuleDefinition(request.body)));
    return reply.code(201).send({ rule });
  });

  app.patch("/api/businesses/:id/rules/:ruleId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, ruleId } = ruleParams.parse(request.params);
    return withMembership(pool, user.id, id, RULE_WRITER_ROLES, async (c) => {
      const patch = parseRuleDefinition(request.body, true);
      const rule = await updateRule(c, id, user.id, ruleId, patch);
      if (!rule) throw new NotFound();
      return { rule };
    });
  });

  app.delete("/api/businesses/:id/rules/:ruleId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, ruleId } = ruleParams.parse(request.params);
    await withMembership(pool, user.id, id, RULE_WRITER_ROLES, async (c) => {
      if (!(await deleteRule(c, id, user.id, ruleId))) throw new NotFound();
    });
    return reply.code(204).send();
  });

  // Dry run: evaluates and reports; writes nothing (no ledger, tag or audit rows).
  // It only exposes data a viewer can already read, so viewers may preview.
  app.post("/api/businesses/:id/rules/dry-run", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      const body = dryRunBody.parse(request.body ?? {});
      let rules: EvaluableRule[];
      if (body.rules) {
        rules = body.rules.map((raw, i) => {
          try {
            return { id: `draft-${i + 1}`, ...parseRuleDefinition(raw) };
          } catch (e) {
            if (e instanceof RuleValidationError) {
              throw new RuleValidationError(e.issues.map((m) => `rules[${i}].${m}`));
            }
            throw e;
          }
        });
      } else {
        rules = (await listRules(c, id)).map(toEvaluable);
      }
      const names = new Map(rules.map((r) => [r.id, r.name]));
      const { scanned, items } = await previewRules(c, id, rules, body);
      return {
        dryRun: true,
        scanned,
        matched: items.length,
        results: items.map((i) => ({
          transactionId: i.transactionId,
          description: i.description,
          date: i.date,
          matchedRules: i.evaluation.matchedRuleIds.map((rid) => ({ id: rid, name: names.get(rid) })),
          changes: {
            category: i.evaluation.category,
            addNotes: i.evaluation.notes,
            addTags: i.evaluation.tags,
          },
          overriddenCategories: i.evaluation.overridden,
          skipped: i.skipped,
        })),
      };
    });
  });

  // Apply the stored, enabled rules to existing transactions.
  app.post("/api/businesses/:id/rules/apply", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    return withMembership(pool, user.id, id, RULE_WRITER_ROLES, async (c) => {
      const body = applyBody.parse(request.body ?? {});
      return applyRules(c, id, user.id, body);
    });
  });
}
