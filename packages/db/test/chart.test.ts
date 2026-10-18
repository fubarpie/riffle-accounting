import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHART } from '../src/chart.js';
import { admin, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

describe('default chart', () => {
  it('template is well-formed: unique codes, code ranges match type', () => {
    const codes = DEFAULT_CHART.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const lead: Record<string, string[]> = {
      asset: ['1'], liability: ['2'], equity: ['3'], income: ['4'], expense: ['5', '6'],
    };
    for (const a of DEFAULT_CHART) expect(lead[a.type], a.code).toContain(a.code[0]);
    expect(DEFAULT_CHART.length).toBe(43);
  });

  it('system accounts exist and imports/opening balances have a home', () => {
    const sys = DEFAULT_CHART.filter((a) => a.system).map((a) => a.name).sort();
    expect(sys).toEqual(['Opening Balance Equity', 'Retained Earnings', 'Uncategorized Expense', 'Uncategorized Income']);
  });

  it('each new business is seeded fully, in its own currency, with valid types', async () => {
    for (const currency of ['USD', 'CAD']) {
      const { businessId } = await makeBusiness(currency);
      const { rows } = await admin.query(
        `SELECT code, type, currency, is_system, contra FROM accounts WHERE business_id=$1 ORDER BY code`, [businessId]);
      expect(rows).toHaveLength(DEFAULT_CHART.length);
      expect(new Set(rows.map((r) => r.currency))).toEqual(new Set([currency]));
      expect(rows.filter((r) => r.is_system)).toHaveLength(4);
      expect(rows.find((r) => r.code === '1510')).toMatchObject({ type: 'asset', contra: true });
    }
  });

  it('two businesses may use the same codes (uniqueness is per business)', async () => {
    const a = await makeBusiness(); const b = await makeBusiness();
    expect(a.accounts.get('1010')).not.toBe(b.accounts.get('1010'));
  });
});
