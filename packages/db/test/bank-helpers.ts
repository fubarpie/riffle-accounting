import { randomBytes } from 'node:crypto';
import { withMembership } from '../src/access.js';
import { BANK_WRITER_ROLES, createConnection, linkAccount, parseKeyring } from '../src/index.js';
import type { ParsedTransaction } from '../src/index.js';
import type { MembershipRole } from '../src/types.js';
import { withTenant } from '../src/tenant.js';
import { uuidv7 } from '../src/uuid.js';
import { admin, app, makeBusiness, makeUser } from './helpers.js';

export const newKey = (): string => randomBytes(32).toString('base64');
export const SECRET_URL = 'https://user:s3cretpass@bridge.example.test/simplefin';

export async function addMember(businessId: string, role: MembershipRole): Promise<string> {
  const u = await makeUser(role);
  await admin.query('INSERT INTO memberships (id, user_id, business_id, role) VALUES ($1,$2,$3,$4)',
    [uuidv7(), u, businessId, role]);
  return u;
}

/** A business with one connection and one linked provider account ('ACT-1' -> Checking 1010). */
export async function bankSetup() {
  const keyring = parseKeyring(`1:${newKey()}`);
  const b = await makeBusiness();
  const ctx = { userId: b.userId, businessId: b.businessId };
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app, ctx, fn);
  const conn = await run((c) => createConnection(c, b.businessId, b.userId,
    { label: 'Main bank', accessUrl: SECRET_URL, scheduleMinute: 7 }, keyring));
  const link = await run((c) => linkAccount(c, b.businessId, b.userId, {
    connectionId: conn.id, externalAccountId: 'ACT-1', externalName: 'Checking', accountId: b.accounts.get('1010')!,
  }));
  const a = (code: string) => b.accounts.get(code)!;
  /** Run as `userId` with the writer-role gate the API layer applies. */
  const asWriter = <T>(userId: string, fn: Parameters<typeof withMembership<T>>[4]) =>
    withMembership(app, userId, b.businessId, BANK_WRITER_ROLES, fn);
  return { ...b, ctx, run, keyring, conn, link, a, asWriter };
}

let n = 0;
export const tx = (over: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
  externalAccountId: 'ACT-1', externalId: `T-${++n}-${uuidv7()}`, postedDate: '2026-03-10',
  amountMinor: -1250n, description: 'COFFEE SHOP', pending: false, ...over,
});
