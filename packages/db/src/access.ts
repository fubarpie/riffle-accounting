import type { Pool, PoolClient } from 'pg';
import type { MembershipRole } from './types.js';
import { withTenant } from './tenant.js';

const RANK: Record<MembershipRole, number> = { viewer: 0, bookkeeper: 1, admin: 2, owner: 3 };

/** True when `role` is at least `min` in the owner > admin > bookkeeper > viewer order. */
export function roleAtLeast(role: MembershipRole, min: MembershipRole): boolean {
  return RANK[role] >= RANK[min];
}

/** The caller has no membership in the business (indistinguishable from "no such business"). */
export class NotAMemberError extends Error {}
/** The caller is a member but their role is too low for the operation. */
export class ForbiddenError extends Error {}

export interface MemberAccess {
  userId: string;
  businessId: string;
  role: MembershipRole;
}

/**
 * Authorise `userId` against `businessId`, then run `fn` inside a transaction
 * that RLS confines to that business. The role lookup and the business scoping
 * share one transaction, so there is no window where the role could change
 * between check and use.
 *
 * `allowed` lists the roles permitted to run `fn`.
 */
export async function withMembership<T>(
  pool: Pool,
  userId: string,
  businessId: string,
  allowed: readonly MembershipRole[],
  fn: (client: PoolClient, access: MemberAccess) => Promise<T>,
): Promise<T> {
  return withTenant(pool, { userId }, async (c) => {
    const { rows } = await c.query<{ role: MembershipRole }>(
      'SELECT role FROM memberships WHERE user_id = $1 AND business_id = $2', [userId, businessId]);
    const role = rows[0]?.role;
    if (!role) throw new NotAMemberError();
    if (!allowed.includes(role)) throw new ForbiddenError();
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [businessId]);
    return fn(c, { userId, businessId, role });
  });
}
