import type { Pool, PoolClient } from 'pg';

export interface TenantContext {
  /** Authenticated user. Required. */
  userId: string;
  /**
   * Active business. Callers MUST have verified the user's membership (and
   * role) before passing this; RLS then confines the transaction to it.
   */
  businessId?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction whose RLS context is set with SET LOCAL semantics
 * (set_config(..., true)), so the settings vanish at COMMIT/ROLLBACK and can
 * never leak onto a pooled connection.
 */
export async function withTenant<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.userId)) throw new TypeError('userId must be a UUID');
  if (ctx.businessId !== undefined && !UUID.test(ctx.businessId)) {
    throw new TypeError('businessId must be a UUID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.business_id', $2, true)`,
      [ctx.userId, ctx.businessId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
