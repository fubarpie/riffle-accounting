import type { PoolClient } from 'pg';
import type { AccountType } from './types.js';
import { uuidv7 } from './uuid.js';

export interface ChartTemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  contra?: boolean;
  system?: boolean;
}

/** Standard small-business chart (ADR-0004). Cost of goods sold is type `expense`. */
export const DEFAULT_CHART: readonly ChartTemplateAccount[] = [
  { code: '1000', name: 'Cash on Hand', type: 'asset' },
  { code: '1010', name: 'Checking', type: 'asset' },
  { code: '1020', name: 'Savings', type: 'asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { code: '1200', name: 'Inventory', type: 'asset' },
  { code: '1300', name: 'Prepaid Expenses', type: 'asset' },
  { code: '1500', name: 'Equipment', type: 'asset' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset', contra: true },
  { code: '2000', name: 'Accounts Payable', type: 'liability' },
  { code: '2100', name: 'Credit Card', type: 'liability' },
  { code: '2200', name: 'Sales Tax Payable', type: 'liability' },
  { code: '2300', name: 'Payroll Liabilities', type: 'liability' },
  { code: '2500', name: 'Loans Payable', type: 'liability' },
  { code: '3000', name: "Owner's Equity", type: 'equity' },
  { code: '3100', name: "Owner's Contributions", type: 'equity' },
  { code: '3200', name: "Owner's Draws", type: 'equity' },
  { code: '3800', name: 'Opening Balance Equity', type: 'equity', system: true },
  { code: '3900', name: 'Retained Earnings', type: 'equity', system: true },
  { code: '4000', name: 'Sales', type: 'income' },
  { code: '4100', name: 'Service Revenue', type: 'income' },
  { code: '4200', name: 'Interest Income', type: 'income' },
  { code: '4300', name: 'Other Income', type: 'income' },
  { code: '4900', name: 'Uncategorized Income', type: 'income', system: true },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense' },
  { code: '5100', name: 'Shipping and Freight', type: 'expense' },
  { code: '6000', name: 'Advertising and Marketing', type: 'expense' },
  { code: '6010', name: 'Bank Fees', type: 'expense' },
  { code: '6020', name: 'Contractors', type: 'expense' },
  { code: '6030', name: 'Depreciation', type: 'expense' },
  { code: '6040', name: 'Insurance', type: 'expense' },
  { code: '6050', name: 'Interest Expense', type: 'expense' },
  { code: '6060', name: 'Licenses and Permits', type: 'expense' },
  { code: '6070', name: 'Meals', type: 'expense' },
  { code: '6080', name: 'Office Supplies', type: 'expense' },
  { code: '6090', name: 'Professional Fees', type: 'expense' },
  { code: '6100', name: 'Rent', type: 'expense' },
  { code: '6110', name: 'Repairs and Maintenance', type: 'expense' },
  { code: '6120', name: 'Software and Subscriptions', type: 'expense' },
  { code: '6130', name: 'Taxes', type: 'expense' },
  { code: '6140', name: 'Travel', type: 'expense' },
  { code: '6150', name: 'Utilities', type: 'expense' },
  { code: '6160', name: 'Wages and Salaries', type: 'expense' },
  { code: '6900', name: 'Uncategorized Expense', type: 'expense', system: true },
];

/** Insert the default chart for a business. Runs inside a tenant transaction. */
export async function seedDefaultChart(
  client: PoolClient,
  businessId: string,
  currency: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const a of DEFAULT_CHART) {
    const id = uuidv7();
    await client.query(
      `INSERT INTO accounts (id, business_id, code, name, type, contra, currency, is_system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, businessId, a.code, a.name, a.type, a.contra ?? false, currency, a.system ?? false],
    );
    ids.set(a.code, id);
  }
  return ids;
}
