/**
 * Drizzle definitions of the tables created by migrations/*.sql.
 *
 * The SQL migrations are the source of truth: Drizzle cannot express RLS
 * policies, constraint triggers or roles. test/schema-drift.test.ts fails if
 * these definitions and the migrated database disagree.
 */
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, customType, date, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'bookkeeper', 'viewer']);
export const accountType = pgEnum('account_type', ['asset', 'liability', 'equity', 'income', 'expense']);
export const transactionKind = pgEnum('transaction_kind', ['deposit', 'withdrawal', 'transfer', 'journal']);
export const bankConnectionStatus = pgEnum('bank_connection_status', ['active', 'disabled', 'error']);
export const stagedStatus = pgEnum('staged_status', ['new', 'approved', 'ignored', 'posted']);
export const reconciliationStatus = pgEnum('reconciliation_status', ['draft', 'completed', 'voided']);

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

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().default(sql`now()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
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

export const rules = pgTable('rules', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  name: text('name').notNull(),
  priority: integer('priority').notNull().default(100),
  strict: boolean('strict').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  conditions: jsonb('conditions').notNull(),
  actions: jsonb('actions').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const transactionTags = pgTable('transaction_tags', {
  businessId: uuid('business_id').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  tag: text('tag').notNull(),
  createdAt: createdAt(),
});

export const bankConnections = pgTable('bank_connections', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  label: text('label').notNull(),
  /** AES-256-GCM envelope. Never select this outside bank/connections.ts#getAccessUrl. */
  accessUrlEnc: bytea('access_url_enc').notNull(),
  accessUrlKeyId: text('access_url_key_id').notNull(),
  status: bankConnectionStatus('status').notNull().default('active'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  scheduleMinute: smallint('schedule_minute').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const bankAccountLinks = pgTable('bank_account_links', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  externalAccountId: text('external_account_id').notNull(),
  externalName: text('external_name').notNull().default(''),
  accountId: uuid('account_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const stagedTransactions = pgTable('staged_transactions', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  connectionId: uuid('connection_id'),
  source: text('source').notNull().default('simplefin'),
  linkId: uuid('link_id'),
  accountId: uuid('account_id').notNull(),
  externalId: text('external_id').notNull(),
  postedDate: date('posted_date').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  description: text('description').notNull().default(''),
  pending: boolean('pending').notNull().default(false),
  raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
  status: stagedStatus('status').notNull().default('new'),
  categoryAccountId: uuid('category_account_id'),
  transactionId: uuid('transaction_id'),
  createdBy: uuid('created_by').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: updatedAt(),
});

export const reconciliations = pgTable('reconciliations', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  accountId: uuid('account_id').notNull(),
  statementStart: date('statement_start').notNull(),
  statementEnd: date('statement_end').notNull(),
  openingBalanceMinor: bigint('opening_balance_minor', { mode: 'bigint' }).notNull(),
  closingBalanceMinor: bigint('closing_balance_minor', { mode: 'bigint' }).notNull(),
  status: reconciliationStatus('status').notNull().default('draft'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: uuid('completed_by'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: uuid('voided_by'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const reconciliationItems = pgTable('reconciliation_items', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  reconciliationId: uuid('reconciliation_id').notNull(),
  lineId: uuid('line_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
});

export const statementDocuments = pgTable('statement_documents', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  reconciliationId: uuid('reconciliation_id'),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  storageKey: text('storage_key').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(),
  createdAt: createdAt(),
});
