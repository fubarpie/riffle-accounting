/**
 * Drizzle definitions of the tables created by migrations/*.sql.
 *
 * The SQL migrations are the source of truth: Drizzle cannot express RLS
 * policies, constraint triggers or roles. test/schema-drift.test.ts fails if
 * these definitions and the migrated database disagree.
 */
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, date, jsonb, pgEnum, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'bookkeeper', 'viewer']);
export const accountType = pgEnum('account_type', ['asset', 'liability', 'equity', 'income', 'expense']);
export const transactionKind = pgEnum('transaction_kind', ['deposit', 'withdrawal', 'transfer', 'journal']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`);
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  booksLockedThrough: date('books_locked_through'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  businessId: uuid('business_id').notNull(),
  role: membershipRole('role').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  code: text('code'),
  name: text('name').notNull(),
  type: accountType('type').notNull(),
  contra: boolean('contra').notNull().default(false),
  parentId: uuid('parent_id'),
  currency: char('currency', { length: 3 }).notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  kind: transactionKind('kind').notNull(),
  date: date('date').notNull(),
  description: text('description').notNull().default(''),
  notes: text('notes').notNull().default(''),
  currentEntryId: uuid('current_entry_id'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  entryDate: date('entry_date').notNull(),
  reversesEntryId: uuid('reverses_entry_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const journalLines = pgTable('journal_lines', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  entryId: uuid('entry_id').notNull(),
  accountId: uuid('account_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  memo: text('memo').notNull().default(''),
  createdAt: createdAt(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  at: timestamp('at', { withTimezone: true }).notNull().default(sql`now()`),
  before: jsonb('before'),
  after: jsonb('after'),
});
