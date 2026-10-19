// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType } from '../types.js';

const GROUP_TO_TYPE: Readonly<Record<string, AccountType>> = {
  asset: 'asset', liability: 'liability', equity: 'equity', income: 'income', expense: 'expense',
};

/**
 * The ledger type a source account class (e.g. Wave's "Account Group") implies,
 * or null when it is blank or not one we recognise (then we cannot judge, so
 * nothing is blocked on it).
 */
export function expectedAccountType(sourceGroup: string): AccountType | null {
  return GROUP_TO_TYPE[sourceGroup.trim().toLowerCase()] ?? null;
}
