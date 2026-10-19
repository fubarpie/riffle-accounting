-- 0008_import_staging.sql
-- Phase 6: staging area for migrating from Wave (and later, other bookkeeping
-- exports). See docs/adr/0012-wave-migration.md.
--
-- An import batch is a CANDIDATE reading of an uploaded file. Nothing in these
-- tables is part of the ledger. A bookkeeper reviews the batch (maps accounts,
-- excludes or fixes entries) and approves it; approval posts each valid entry
-- through the normal ledger path in one transaction, and records the external
-- id of every posted entry in imported_refs so re-importing the same entry is
-- a no-op.
--
-- Privacy: the file itself is processed in memory and is not stored. Only the
-- parsed rows live here, scoped by business with row-level security. Full
-- account numbers are NOT stored; at most the last 4 characters are kept so a
-- person can tell two similarly named accounts apart.

CREATE TYPE import_batch_status AS ENUM ('staged', 'approved', 'rejected');
CREATE TYPE import_entry_status AS ENUM ('valid', 'invalid', 'skipped');

-- ------------------------------------------------------------ import_batches
CREATE TABLE import_batches (
  id           uuid PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses (id),
  -- Which parser produced the batch, e.g. 'wave_journal'.
  source       text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- Hash of the uploaded bytes: lets us refuse the same file twice.
  file_sha256  char(64) NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  status       import_batch_status NOT NULL DEFAULT 'staged',
  -- Parser report: counts, warnings, account-mapping notes. No row data.
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid NOT NULL REFERENCES users (id),
  approved_by  uuid REFERENCES users (id),
  approved_at  timestamptz,
  rejected_by  uuid REFERENCES users (id),
  rejected_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK ((rejected_at IS NULL) = (rejected_by IS NULL)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejected_at IS NOT NULL))
);
CREATE INDEX import_batches_list_idx ON import_batches (business_id, created_at DESC, id DESC);
-- The same file cannot be staged twice unless the earlier batch was rejected.
CREATE UNIQUE INDEX import_batches_file_once_idx
  ON import_batches (business_id, source, file_sha256) WHERE status <> 'rejected';

-- ----------------------------------------------------------- import_accounts
-- One row per distinct account in the file (matched by normalized name).
CREATE TABLE import_accounts (
  id              uuid PRIMARY KEY,
  business_id     uuid NOT NULL REFERENCES businesses (id),
  batch_id        uuid NOT NULL,
  -- As printed in the file (for display), and the normalized form used to match.
  source_name     text NOT NULL CHECK (length(btrim(source_name)) > 0 AND length(source_name) <= 200),
  match_key       text NOT NULL CHECK (length(match_key) BETWEEN 1 AND 200),
  source_group    text NOT NULL DEFAULT '' CHECK (length(source_group) <= 100),
  source_type     text NOT NULL DEFAULT '' CHECK (length(source_type) <= 100),
  -- Last 4 characters of any account number in the file, never the whole number.
  account_ref_last4 text CHECK (account_ref_last4 IS NULL OR length(account_ref_last4) <= 4),
  -- Resolution chosen by the reviewer: map to an existing account, or create one.
  -- Both NULL means "not decided yet" and blocks approval of entries using it.
  target_account_id uuid,
  create_name     text CHECK (create_name IS NULL OR length(btrim(create_name)) > 0),
  create_type     account_type,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, batch_id, match_key),
  FOREIGN KEY (business_id, batch_id) REFERENCES import_batches (business_id, id),
  FOREIGN KEY (business_id, target_account_id) REFERENCES accounts (business_id, id),
  CHECK (NOT (target_account_id IS NOT NULL AND create_name IS NOT NULL)),
  CHECK ((create_name IS NULL) = (create_type IS NULL))
);

-- ------------------------------------------------------------ import_entries
CREATE TABLE import_entries (
  id             uuid PRIMARY KEY,
  business_id    uuid NOT NULL REFERENCES businesses (id),
  batch_id       uuid NOT NULL,
  -- The id the source system gave the entry (Wave: 19 digits, kept as text).
  external_id    text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  -- NULL only when the date could not be read (then status is 'invalid').
  entry_date     date,
  description    text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  status         import_entry_status NOT NULL,
  -- Parser findings for this entry: [{severity, code, message}]. No account numbers.
  issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- A reviewer chose to leave this entry out of the import.
  excluded       boolean NOT NULL DEFAULT false,
  -- Set when approval posted the entry.
  transaction_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, batch_id, id),
  UNIQUE (business_id, batch_id, external_id),
  FOREIGN KEY (business_id, batch_id) REFERENCES import_batches (business_id, id),
  FOREIGN KEY (business_id, transaction_id) REFERENCES transactions (business_id, id),
  CHECK (status <> 'valid' OR entry_date IS NOT NULL),
  CHECK (transaction_id IS NULL OR (status = 'valid' AND NOT excluded))
);
CREATE INDEX import_entries_batch_idx ON import_entries (business_id, batch_id, entry_date, id);

-- -------------------------------------------------------- import_entry_lines
CREATE TABLE import_entry_lines (
  id                uuid PRIMARY KEY,
  business_id       uuid NOT NULL REFERENCES businesses (id),
  batch_id          uuid NOT NULL,
  entry_id          uuid NOT NULL,
  line_no           integer NOT NULL CHECK (line_no >= 1),
  import_account_id uuid NOT NULL,
  -- Signed integer minor units, same convention as journal_lines:
  -- debit positive, credit negative, never zero.
  amount_minor      bigint NOT NULL CHECK (amount_minor <> 0),
  memo              text NOT NULL DEFAULT '' CHECK (length(memo) <= 1000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, entry_id, line_no),
  FOREIGN KEY (business_id, batch_id, entry_id) REFERENCES import_entries (business_id, batch_id, id),
  FOREIGN KEY (business_id, import_account_id) REFERENCES import_accounts (business_id, id)
);
CREATE INDEX import_entry_lines_entry_idx ON import_entry_lines (business_id, entry_id);

-- ------------------------------------------------------------ imported_refs
-- Append-only record of source entries that have reached the ledger. This, not
-- the batch, is what makes importing idempotent across overlapping files.
CREATE TABLE imported_refs (
  business_id    uuid NOT NULL REFERENCES businesses (id),
  source         text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{0,31}$'),
  external_id    text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  transaction_id uuid NOT NULL,
  batch_id       uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, source, external_id),
  FOREIGN KEY (business_id, transaction_id) REFERENCES transactions (business_id, id),
  FOREIGN KEY (business_id, batch_id) REFERENCES import_batches (business_id, id)
);
CREATE TRIGGER imported_refs_immutable BEFORE UPDATE OR DELETE ON imported_refs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ------------------------------------------------------------------ guards
-- Batch rows: provenance never changes; approved/rejected are terminal;
-- approval only from staged; batches are never deleted (reject them).
CREATE FUNCTION import_batches_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import batches cannot be deleted; reject them' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'staged' THEN
      RAISE EXCEPTION 'an import batch must start staged' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.source <> OLD.source
     OR NEW.file_sha256 <> OLD.file_sha256 OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'import batch provenance is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION '% import batches are immutable', OLD.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION import_batches_guard();

-- Child rows (accounts, entries, lines) can change only while the batch is staged.
CREATE FUNCTION import_children_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_status import_batch_status;
  parent_id uuid;
  parent_biz uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.batch_id; parent_biz := OLD.business_id;
  ELSE
    parent_id := NEW.batch_id; parent_biz := NEW.business_id;
  END IF;
  SELECT status INTO parent_status FROM import_batches
    WHERE business_id = parent_biz AND id = parent_id;
  IF parent_status IS NULL OR parent_status <> 'staged' THEN
    RAISE EXCEPTION 'rows of a % import batch cannot change', coalesce(parent_status::text, 'missing')
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON import_accounts
  FOR EACH ROW EXECUTE FUNCTION import_children_guard();
CREATE TRIGGER import_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON import_entries
  FOR EACH ROW EXECUTE FUNCTION import_children_guard();
CREATE TRIGGER import_entry_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON import_entry_lines
  FOR EACH ROW EXECUTE FUNCTION import_children_guard();

-- An entry marked 'valid' must have at least two lines that sum to exactly zero.
-- Checked at COMMIT (deferred) so the entry and its lines can be written in any order.
CREATE FUNCTION import_entry_balance_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  eid uuid;
  biz uuid;
  st import_entry_status;
  n integer;
  total numeric;
BEGIN
  IF TG_TABLE_NAME = 'import_entries' THEN
    eid := NEW.id; biz := NEW.business_id;
  ELSIF TG_OP = 'DELETE' THEN
    eid := OLD.entry_id; biz := OLD.business_id;
  ELSE
    eid := NEW.entry_id; biz := NEW.business_id;
  END IF;
  SELECT status INTO st FROM import_entries WHERE business_id = biz AND id = eid;
  IF st IS NULL OR st <> 'valid' THEN
    RETURN NULL;
  END IF;
  SELECT count(*), coalesce(sum(amount_minor), 0) INTO n, total
    FROM import_entry_lines WHERE business_id = biz AND entry_id = eid;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'a valid import entry needs 2 or more lines that balance to zero'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER import_entries_balance AFTER INSERT OR UPDATE ON import_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION import_entry_balance_check();
CREATE CONSTRAINT TRIGGER import_entry_lines_balance AFTER INSERT OR UPDATE OR DELETE ON import_entry_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION import_entry_balance_check();

CREATE TRIGGER import_batches_no_truncate BEFORE TRUNCATE ON import_batches
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER import_accounts_no_truncate BEFORE TRUNCATE ON import_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER import_entries_no_truncate BEFORE TRUNCATE ON import_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER import_entry_lines_no_truncate BEFORE TRUNCATE ON import_entry_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER imported_refs_no_truncate BEFORE TRUNCATE ON imported_refs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ------------------------------------------------------------------ RLS
-- Same pattern as every other tenant table: enabled AND forced, one policy on app.business_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batches','import_accounts','import_entries','import_entry_lines','imported_refs']
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

-- ---------------------------------------------------------------- audit
-- As in 0003/0004/0006/0007, audit rows (import.stage / .map / .exclude /
-- .approve / .reject) are written by the application in the same transaction.

-- --------------------------------------------------------------- grants
-- No DELETE on batches or refs. Children may be deleted (the trigger limits
-- that to staged batches) because re-staging replaces a batch's rows.
GRANT SELECT, INSERT, UPDATE ON import_batches TO riffle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_accounts, import_entries, import_entry_lines TO riffle_app;
GRANT SELECT, INSERT ON imported_refs TO riffle_app;
