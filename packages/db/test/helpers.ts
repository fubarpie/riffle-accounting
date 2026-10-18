import pg from 'pg';
import { createBusiness } from '../src/ledger.js';
import { uuidv7 } from '../src/uuid.js';

/** Superuser/owner pool: fixtures and catalog inspection only. */
export const admin = new pg.Pool({ connectionString: process.env.TEST_ADMIN_URL, max: 3 });
/** Application pool: connects as riffle_app, subject to RLS. */
export const app = new pg.Pool({ connectionString: process.env.TEST_APP_URL, max: 8 });

export async function makeUser(label = 'u'): Promise<string> {
  const id = uuidv7();
  await admin.query('INSERT INTO users (id, email, name) VALUES ($1,$2,$3)',
    [id, `${label}-${id}@example.test`, label]);
  return id;
}

export async function makeBusiness(currency = 'USD'): Promise<{
  userId: string; businessId: string; accounts: Map<string, string>;
}> {
  const userId = await makeUser('owner');
  const businessId = await createBusiness(app, userId, { name: `Biz ${uuidv7()}`, currency });
  const { rows } = await admin.query<{ id: string; code: string }>(
    'SELECT id, code FROM accounts WHERE business_id = $1', [businessId]);
  return { userId, businessId, accounts: new Map(rows.map((r) => [r.code, r.id])) };
}

export async function closePools(): Promise<void> {
  await Promise.all([admin.end(), app.end()]);
}
