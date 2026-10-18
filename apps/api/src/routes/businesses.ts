// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ROLES_THAT_CAN_READ_AUDIT_LOG, audit, createBusiness, normalizeEmail,
  uuidv7, withMembership, withTenant, type MembershipRole,
} from "@riffle/db";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import { Conflict, NotFound, Refused } from "../errors";

const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];
const MANAGERS: readonly MembershipRole[] = ["owner", "admin"];
const roleEnum = z.enum(["owner", "admin", "bookkeeper", "viewer"]);
const idParams = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD"),
});

/** Admins may only manage bookkeepers and viewers; owners manage everyone. */
function canManage(actor: MembershipRole, target: MembershipRole, newRole?: MembershipRole): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  const low = (r: MembershipRole) => r === "bookkeeper" || r === "viewer";
  return low(target) && (newRole === undefined || low(newRole));
}


export async function businessRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  app.get("/api/businesses", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const rows = await withTenant(pool, { userId: user.id }, async (c) =>
      (await c.query(
        `SELECT b.id, b.name, b.currency, m.role
           FROM memberships m JOIN businesses b ON b.id = m.business_id
          WHERE m.user_id = $1 ORDER BY b.name`, [user.id])).rows);
    return { businesses: rows };
  });

  app.post("/api/businesses", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = createBody.parse(request.body);
    const id = await createBusiness(pool, user.id, body);
    return reply.code(201).send({ business: { id, name: body.name, currency: body.currency, role: "owner" } });
  });

  app.get("/api/businesses/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = idParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c, a) => {
      const { rows } = await c.query(
        'SELECT id, name, currency, books_locked_through AS "booksLockedThrough" FROM businesses WHERE id = $1', [id]);
      return { business: { ...rows[0], role: a.role } };
    });
  });

  app.get("/api/businesses/:id/accounts", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = idParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => ({
      accounts: (await c.query('SELECT * FROM accounts ORDER BY code')).rows,
    }));
  });

  // ------------------------------------------------------------ members
  app.get("/api/businesses/:id/members", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = idParams.parse(request.params);
    return withMembership(pool, user.id, id, MANAGERS, async (c) => ({
      members: (await c.query(
        `SELECT u.id AS "userId", u.email, u.name, m.role
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.business_id = $1 ORDER BY u.email`, [id])).rows,
    }));
  });

  const addBody = z.object({ email: z.email().max(254), role: roleEnum });
  app.post("/api/businesses/:id/members", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = idParams.parse(request.params);
    const body = addBody.parse(request.body);
    const member = await withMembership(pool, user.id, id, MANAGERS, async (c, a) => {
      if (!canManage(a.role, body.role, body.role)) throw new Refused();
      const found = await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [normalizeEmail(body.email)]);
      const target = found.rows[0];
      if (!target) throw new NotFound();
      const dup = await c.query('SELECT 1 FROM memberships WHERE user_id = $1 AND business_id = $2', [target.id, id]);
      if (dup.rowCount) throw new Conflict("Already a member");
      await c.query('INSERT INTO memberships (id, user_id, business_id, role) VALUES ($1,$2,$3,$4)',
        [uuidv7(), target.id, id, body.role]);
      await audit(c, id, user.id, "member.add", "membership", target.id, undefined, { role: body.role });
      return { userId: target.id, role: body.role };
    });
    return reply.code(201).send({ member });
  });

  const patchBody = z.object({ role: roleEnum });
  app.patch("/api/businesses/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, userId } = memberParams.parse(request.params);
    const body = patchBody.parse(request.body);
    return withMembership(pool, user.id, id, MANAGERS, async (c, a) => {
      const cur = await currentRole(c, id, userId);
      if (!canManage(a.role, cur, body.role)) throw new Refused();
      await c.query('UPDATE memberships SET role = $1, updated_at = now() WHERE user_id = $2 AND business_id = $3',
        [body.role, userId, id]);
      await audit(c, id, user.id, "member.role_change", "membership", userId, { role: cur }, { role: body.role });
      return { member: { userId, role: body.role } };
    });
  });

  app.delete("/api/businesses/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, userId } = memberParams.parse(request.params);
    await withMembership(pool, user.id, id, ALL_ROLES, async (c, a) => {
      const cur = await currentRole(c, id, userId);
      // Anyone may leave; removing someone else needs authority over them.
      if (userId !== user.id && !canManage(a.role, cur)) throw new Refused();
      await c.query('DELETE FROM memberships WHERE user_id = $1 AND business_id = $2', [userId, id]);
      await audit(c, id, user.id, userId === user.id ? "member.leave" : "member.remove",
        "membership", userId, { role: cur }, undefined);
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------- audit log
  const auditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.uuid().optional(),
  });
  app.get("/api/businesses/:id/audit-log", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = idParams.parse(request.params);
    const q = auditQuery.parse(request.query);
    return withMembership(pool, user.id, id, ROLES_THAT_CAN_READ_AUDIT_LOG, async (c) => {
      const { rows } = await c.query(
        `SELECT id, actor_user_id AS "actorUserId", action, entity, entity_id AS "entityId", at, before, after
           FROM audit_log WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
        [q.before ?? null, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return { entries: page, nextBefore: rows.length > q.limit ? page[page.length - 1].id : null };
    });
  });
}

async function currentRole(c: PoolClient, businessId: string, userId: string): Promise<MembershipRole> {
  const { rows } = await c.query<{ role: MembershipRole }>(
    'SELECT role FROM memberships WHERE user_id = $1 AND business_id = $2', [userId, businessId]);
  if (!rows[0]) throw new NotFound();
  return rows[0].role;
}
