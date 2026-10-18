-- 0001_core_ledger.sql
-- Core tenancy + double-entry ledger. See docs/adr/0004-ledger-and-tenancy-schema.md.
--
-- Run as the table-owner role (NOT the application role). The application
-- connects as `riffle_app`, which is not a superuser, owns nothing and has no
-- BYPASSRLS. Operators must give it a login/password, e.g.
--   ALTER ROLE riffle_app LOGIN PASSWORD '...';

-- ---------------------------------------------------------------- roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'riffle_app') THEN
    CREATE ROLE riffle_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------- enums
CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'bookkeeper', 'viewer');
CREATE TYPE account_type    AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
CREATE TYPE transaction_kind AS ENUM ('deposit', 'withdrawal', 'transfer', 'journal');

-- ------------------------------------------------- request context helpers
-- Both return NULL when unset, so policies match nothing without context.
CREATE FUNCTION app_business_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ------------------------------------------------------- global tables
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE businesses (
  id                   uuid PRIMARY KEY,
  name                 text NOT NULL CHECK (length(btrim(name)) > 0),
  currency             char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  books_locked_through date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  business_id uuid NOT NULL REFERENCES businesses (id),
  role        membership_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_id)
);
CREATE INDEX memberships_business_idx ON memberships (business_id);

-- ------------------------------------------------------- tenant tables
CREATE TABLE accounts (
  id          uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses (id),
  code        text,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  type        account_type NOT NULL,
  contra      boolean NOT NULL DEFAULT false,
  parent_id   uuid,
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  is_system   boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, code),
  FOREIGN KEY (business_id, parent_id) REFERENCES accounts (business_id, id)
);

CREATE TABLE transactions (
  id               uuid PRIMARY KEY,
  business_id      uuid NOT NULL REFERENCES businesses (id),
  kind             transaction_kind NOT NULL,
  date             date NOT NULL,
  description      text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  current_entry_id uuid,
  voided_at        timestamptz,
  created_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK (voided_at IS NULL OR current_entry_id IS NULL)
);

CREATE TABLE journal_entries (
  id                uuid PRIMARY KEY,
  business_id       uuid NOT NULL REFERENCES businesses (id),
  transaction_id    uuid NOT NULL,
  entry_date        date NOT NULL,
  reverses_entry_id uuid,
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, transaction_id) REFERENCES transactions (business_id, id),
  FOREIGN KEY (business_id, reverses_entry_id) REFERENCES journal_entries (business_id, id)
);
CREATE INDEX journal_entries_txn_idx ON journal_entries (business_id, transaction_id);

-- transactions.current_entry_id <-> journal_entries is circular, so the FK is
-- deferred and checked at commit.
ALTER TABLE transactions
  ADD FOREIGN KEY (business_id, current_entry_id)
  REFERENCES journal_entries (business_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses (id),
  entry_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  -- Signed minor units: debit positive, credit negative, never zero.
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  memo         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, entry_id)   REFERENCES journal_entries (business_id, id),
  FOREIGN KEY (business_id, account_id) REFERENCES accounts (business_id, id)
);
CREATE INDEX journal_lines_entry_idx   ON journal_lines (business_id, entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (business_id, account_id);

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY,
  business_id   uuid NOT NULL REFERENCES businesses (id),
  actor_user_id uuid REFERENCES users (id),
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     uuid,
  at            timestamptz NOT NULL DEFAULT now(),
  before        jsonb,
  after         jsonb,
  UNIQUE (business_id, id)
);
CREATE INDEX audit_log_business_at_idx ON audit_log (business_id, at DESC);

-- ----------------------------------------------------- ledger invariants
-- Every entry must balance and have at least two lines. Deferred to commit so
-- lines can be inserted one at a time.
CREATE FUNCTION check_entry_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  eid uuid;
  total numeric;
  n integer;
BEGIN
  -- IF, not CASE: plpgsql resolves NEW.<field> per statement, and the two
  -- tables have different columns.
  IF TG_TABLE_NAME = 'journal_entries' THEN
    eid := NEW.id;
  ELSE
    eid := NEW.entry_id;
  END IF;
  SELECT coalesce(sum(amount_minor), 0), count(*) INTO total, n
    FROM journal_lines WHERE entry_id = eid;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two lines (has %)', eid, n
      USING ERRCODE = '23514';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (sum = %)', eid, total
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Posted entries, lines and audit rows are append-only.
CREATE FUNCTION reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Reserved lock date (Phase 4 reconciliation): no posting on or before it.
CREATE FUNCTION check_books_unlocked() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  locked date;
BEGIN
  SELECT books_locked_through INTO locked FROM businesses WHERE id = NEW.business_id;
  IF locked IS NOT NULL AND NEW.entry_date <= locked THEN
    RAISE EXCEPTION 'books are locked through %', locked USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_lock_date BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_books_unlocked();

-- Account rules: currency matches the business, type is frozen once used,
-- system accounts cannot be archived.
CREATE FUNCTION accounts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  biz_currency char(3);
BEGIN
  SELECT currency INTO biz_currency FROM businesses WHERE id = NEW.business_id;
  IF NEW.currency <> biz_currency THEN
    RAISE EXCEPTION 'account currency % must equal business currency %', NEW.currency, biz_currency
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.type <> OLD.type AND EXISTS (
      SELECT 1 FROM journal_lines WHERE business_id = OLD.business_id AND account_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'account type cannot change once the account has lines'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'is_system cannot be changed' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.is_system AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'system accounts cannot be archived' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard();

-- A business's currency is fixed once it has lines.
CREATE FUNCTION businesses_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency <> OLD.currency AND EXISTS (
    SELECT 1 FROM journal_lines WHERE business_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'business currency cannot change once entries exist'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER businesses_guard BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_guard();

-- A business must always keep at least one owner. Deferred so an owner can be
-- swapped inside one transaction.
CREATE FUNCTION memberships_keep_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
     AND NOT EXISTS (
       SELECT 1 FROM memberships WHERE business_id = OLD.business_id AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'business % must keep at least one owner', OLD.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER memberships_keep_owner
  AFTER UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION memberships_keep_owner();

-- Used by the memberships INSERT policy. SECURITY DEFINER so it can see all
-- rows without recursing into the policy it is called from.
CREATE FUNCTION business_has_members(b uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM memberships WHERE business_id = b) $$;
REVOKE ALL ON FUNCTION business_has_members(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_has_members(uuid) TO riffle_app;

-- ------------------------------------------------------------ live view
-- Lines of each transaction's current, non-voided entry. Reports read this so
-- they never re-implement reversal handling. security_invoker keeps RLS on.
CREATE VIEW live_journal_lines WITH (security_invoker = true) AS
  SELECT l.id, l.business_id, l.entry_id, l.account_id, l.amount_minor, l.memo,
         t.id AS transaction_id, e.entry_date
    FROM journal_lines l
    JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.entry_id
    JOIN transactions   t ON t.business_id = e.business_id AND t.id = e.transaction_id
   WHERE t.current_entry_id = e.id AND t.voided_at IS NULL;

-- ------------------------------------------------------------------ RLS
-- Tenant tables: enabled AND forced, one policy keyed on app.business_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','transactions','journal_entries','journal_lines','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO riffle_app
         USING (business_id = app_business_id())
         WITH CHECK (business_id = app_business_id())', t);
  END LOOP;
END
$$;

-- memberships / businesses: keyed on the authenticated user and the active
-- business. Not FORCEd, so the owner role (migrations, SECURITY DEFINER
-- helpers) can still see everything.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT TO riffle_app
  USING (user_id = app_user_id() OR business_id = app_business_id());
-- Insert: the active business (caller verified admin+), or a user making
-- themselves the first member of a business that has none yet.
CREATE POLICY memberships_insert ON memberships FOR INSERT TO riffle_app
  WITH CHECK (
    business_id = app_business_id()
    OR (user_id = app_user_id() AND NOT business_has_members(business_id))
  );
CREATE POLICY memberships_update ON memberships FOR UPDATE TO riffle_app
  USING (business_id = app_business_id())
  WITH CHECK (business_id = app_business_id());
CREATE POLICY memberships_delete ON memberships FOR DELETE TO riffle_app
  USING (business_id = app_business_id());

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY businesses_select ON businesses FOR SELECT TO riffle_app
  USING (
    id = app_business_id()
    OR id IN (SELECT business_id FROM memberships WHERE user_id = app_user_id())
  );
CREATE POLICY businesses_insert ON businesses FOR INSERT TO riffle_app
  WITH CHECK (app_user_id() IS NOT NULL);
CREATE POLICY businesses_update ON businesses FOR UPDATE TO riffle_app
  USING (id = app_business_id()) WITH CHECK (id = app_business_id());

-- --------------------------------------------------------------- grants
-- Least privilege: ledger and audit tables are insert/select only.
GRANT USAGE ON SCHEMA public TO riffle_app;
GRANT SELECT, INSERT, UPDATE ON users, businesses TO riffle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO riffle_app;
GRANT SELECT, INSERT, UPDATE ON accounts, transactions TO riffle_app;
GRANT SELECT, INSERT ON journal_entries, journal_lines, audit_log TO riffle_app;
GRANT SELECT ON live_journal_lines TO riffle_app;
