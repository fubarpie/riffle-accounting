-- 0004_bank_connections.sql
-- Phase 3: bank feed import (SimpleFIN first). See docs/adr/0009-simplefin-import.md.
--
-- Imported rows land in `staged_transactions`, never directly in the ledger.
-- A human (or a rule) approves them and `postStaged` posts a balanced journal
-- entry through the normal ledger path. Staging is therefore mutable working
-- state; the ledger stays append-only (ADR 0004).

CREATE TYPE bank_connection_status AS ENUM ('active', 'disabled', 'error');
CREATE TYPE staged_status          AS ENUM ('new', 'approved', 'ignored', 'posted');

-- ------------------------------------------------------- bank_connections
CREATE TABLE bank_connections (
  id                  uuid PRIMARY KEY,
  business_id         uuid NOT NULL REFERENCES businesses (id),
  label               text NOT NULL CHECK (length(btrim(label)) > 0 AND length(label) <= 120),
  -- AES-256-GCM envelope (format byte | 12-byte IV | 16-byte tag | ciphertext).
  -- The plaintext access URL carries credentials and is never stored. The
  -- application binds business and connection ids as GCM associated data.
  access_url_enc      bytea NOT NULL CHECK (length(access_url_enc) > 29),
  -- Which RIFFLE_SECRET_KEY version encrypted it (supports key rotation).
  access_url_key_id   text NOT NULL CHECK (access_url_key_id ~ '^[A-Za-z0-9_-]{1,16}$'),
  status              bank_connection_status NOT NULL DEFAULT 'active',
  last_synced_at      timestamptz,
  last_error          text CHECK (length(last_error) <= 1000),
  -- Minute past the hour at which the scheduler should sync (spreads load).
  schedule_minute     smallint NOT NULL DEFAULT 0 CHECK (schedule_minute BETWEEN 0 AND 59),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX bank_connections_business_idx ON bank_connections (business_id, created_at);

-- ------------------------------------------------------ bank_account_links
-- Maps a provider account id to the Riffle ledger account it feeds.
CREATE TABLE bank_account_links (
  id                  uuid PRIMARY KEY,
  business_id         uuid NOT NULL REFERENCES businesses (id),
  connection_id       uuid NOT NULL,
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 200),
  external_name       text NOT NULL DEFAULT '' CHECK (length(external_name) <= 200),
  account_id          uuid NOT NULL,
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (connection_id, external_account_id),
  FOREIGN KEY (business_id, connection_id) REFERENCES bank_connections (business_id, id),
  FOREIGN KEY (business_id, account_id)    REFERENCES accounts (business_id, id)
);
CREATE INDEX bank_account_links_account_idx ON bank_account_links (business_id, account_id);

-- ---------------------------------------------------- staged_transactions
CREATE TABLE staged_transactions (
  id                  uuid PRIMARY KEY,
  business_id         uuid NOT NULL REFERENCES businesses (id),
  -- NULL for sources without a connection (Phase 5 statement upload).
  connection_id       uuid,
  -- Open-ended on purpose: 'simplefin' now, 'statement' later.
  source              text NOT NULL DEFAULT 'simplefin' CHECK (source ~ '^[a-z][a-z0-9_]{0,31}$'),
  link_id             uuid,
  -- Ledger account the money moved in or out of (the bank/card account).
  account_id          uuid NOT NULL,
  -- Provider transaction id: the idempotency key together with connection_id.
  external_id         text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  posted_date         date NOT NULL,
  -- Signed minor units as the bank reports them: positive = into the account.
  amount_minor        bigint NOT NULL,
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  pending             boolean NOT NULL DEFAULT false,
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              staged_status NOT NULL DEFAULT 'new',
  -- Category chosen by a person at approval time; NULL = decide at post time.
  category_account_id uuid,
  transaction_id      uuid,
  created_by          uuid NOT NULL REFERENCES users (id),
  imported_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  -- Re-importing the same window (the 5-day overlap) cannot duplicate rows.
  UNIQUE (connection_id, external_id),
  CHECK (source <> 'simplefin' OR connection_id IS NOT NULL),
  CHECK ((status = 'posted') = (transaction_id IS NOT NULL)),
  CHECK (NOT (pending AND status = 'posted')),
  FOREIGN KEY (business_id, connection_id)       REFERENCES bank_connections (business_id, id),
  FOREIGN KEY (business_id, link_id)             REFERENCES bank_account_links (business_id, id),
  FOREIGN KEY (business_id, account_id)          REFERENCES accounts (business_id, id),
  FOREIGN KEY (business_id, category_account_id) REFERENCES accounts (business_id, id),
  FOREIGN KEY (business_id, transaction_id)      REFERENCES transactions (business_id, id)
);
-- NULLs are distinct in the constraint above, so connection-less sources get
-- their own idempotency key.
CREATE UNIQUE INDEX staged_transactions_nonconn_uniq
  ON staged_transactions (business_id, source, external_id) WHERE connection_id IS NULL;
CREATE INDEX staged_transactions_inbox_idx
  ON staged_transactions (business_id, status, posted_date DESC, id);
CREATE UNIQUE INDEX staged_transactions_txn_uniq
  ON staged_transactions (business_id, transaction_id) WHERE transaction_id IS NOT NULL;

-- Once posted, a staged row is a receipt for a ledger transaction: frozen.
CREATE FUNCTION staged_posted_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted staged transactions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER staged_transactions_posted_immutable BEFORE UPDATE ON staged_transactions
  FOR EACH ROW EXECUTE FUNCTION staged_posted_immutable();

-- ------------------------------------------------------------------ RLS
-- Same pattern as 0001/0003: enabled AND forced, one policy on app.business_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_connections','bank_account_links','staged_transactions']
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

-- --------------------------------------------------------------- grants
-- No DELETE on connections or staged rows: disable a connection, ignore a row.
-- Audit rows are written by the application in the same transaction.
GRANT SELECT, INSERT, UPDATE ON bank_connections, staged_transactions TO riffle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_account_links TO riffle_app;
