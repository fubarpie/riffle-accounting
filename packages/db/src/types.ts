export type MembershipRole = 'owner' | 'admin' | 'bookkeeper' | 'viewer';
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type TransactionKind = 'deposit' | 'withdrawal' | 'transfer' | 'journal';

export const ROLES_THAT_CAN_READ_AUDIT_LOG: readonly MembershipRole[] = ['owner', 'admin', 'bookkeeper'];
