-- 0007_statement_extractions.sql
-- Phase 5: AI-assisted statement upload (API only).
-- See docs/adr/0011-ai-statement-upload.md.
--
-- An extraction is a CANDIDATE read of an uploaded statement. It is untrusted
-- data: it never touches the ledger until (a) the validation gate passes
-- (lines sum exactly to closing - opening, etc.) and (b) a bookkeeper approves
-- it. Approval stages each line into staged_transactions (source 'statement',
-- the connection-less hook added in 0004) and posts it through the same
-- postStaged path as the SimpleFIN import, in one transaction.

CREATE TYPE extraction_status AS ENUM ('pending', 'staged', 'flagged', 'approved', 'rejected');

-- ----------------------------------------------------- statement_extractions
CREATE TABLE statement_extractions (
  id                    uuid PRIMARY KEY,
  business_id           uuid NOT NULL REFERENCES businesses (id),
  -- The bank/card ledger account the statement belongs to.
  account_id            uuid NOT NULL,
  -- Original file in the Phase 4 vault, when stored.
  document_id           uuid,
  status                extraction_status NOT NULL DEFAULT 'pending',
  extractor_name        text NOT NULL CHECK (length(extractor_name) BETWEEN 1 AND 64),
  extractor_model       text NOT NULL CHECK (length(extractor_model) BETWEEN 1 AND 128),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  -- Statement balances in signed minor units, exactly as printed. Statement sign:
  -- a positive line amount RAISES the closing balance (deposit on a bank account,
  -- purchase on a card). See ADR 0010/0011.
  opening_balance_minor bigint NOT NULL,
  closing_balance_minor bigint NOT NULL,
  -- Currency the statement printed, if any (checked against the business).
  currency              text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- Latest result of the validation gate (reasons, sums) and its verdict.
  validation            jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_ok         boolean NOT NULL DEFAULT false,
  validated_at          timestamptz,
  created_by            uuid NOT NULL REFERENCES users (id),
  approved_by           uuid REFERENCES users (id),
  approved_at           timestamptz,
  rejected_by           uuid REFERENCES users (id),
  rejected_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, account_id)  REFERENCES accounts (business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES statement_documents (business_id, id),
  -- Defence in depth: a failed gate can never be staged or approved, whatever the app does.
  CHECK (status NOT IN ('staged', 'approved') OR validation_ok),
  CHECK (status <> 'flagged' OR NOT validation_ok),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK ((rejected_at IS NULL) = (rejected_by IS NULL)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejected_at IS NOT NULL))
);
CREATE INDEX statement_extractions_list_idx
  ON statement_extractions (business_id, created_at DESC, id DESC);
CREATE INDEX statement_extractions_account_idx
  ON statement_extractions (business_id, account_id, status);

-- --------------------------------------------------------- extraction_lines
CREATE TABLE extraction_lines (
  id               uuid PRIMARY KEY,
  business_id      uuid NOT NULL REFERENCES businesses (id),
  extraction_id    uuid NOT NULL,
  -- 1-based position in the statement; the stable order of the lines.
  line_no          integer NOT NULL CHECK (line_no >= 1),
  line_date        date NOT NULL,
  description      text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  -- Signed integer minor units, statement sign. 0 together with amount_invalid
  -- means the extractor gave something that is not an exact integer (the gate flags it).
  amount_minor     bigint NOT NULL,
  amount_invalid   boolean NOT NULL DEFAULT false,
  -- A person marked this line as already in the ledger: it counts toward the
  -- balance check but is not posted again.
  already_recorded boolean NOT NULL DEFAULT false,
  -- The extractor's line exactly as received (audit/debug).
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, extraction_id, line_no),
  FOREIGN KEY (business_id, extraction_id) REFERENCES statement_extractions (business_id, id)
);

-- ------------------------------------------------------------------ guards
-- Extraction rows: facts about origin never change. approved/rejected are
-- terminal. Content (period, balances, lines) is editable only before that.
CREATE FUNCTION statement_extractions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extractions cannot be deleted; reject them' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'an extraction cannot start approved or rejected' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.account_id <> OLD.account_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.extractor_name <> OLD.extractor_name OR NEW.extractor_model <> OLD.extractor_model
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'extraction provenance is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION '% extractions are immutable', OLD.status USING ERRCODE = '55000';
  END IF;
  -- Approval only from staged: i.e. only after the gate passed (CHECK also requires validation_ok).
  IF NEW.status = 'approved' AND OLD.status <> 'staged' THEN
    RAISE EXCEPTION 'only a staged (validated) extraction can be approved' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER statement_extractions_guard BEFORE INSERT OR UPDATE OR DELETE ON statement_extractions
  FOR EACH ROW EXECUTE FUNCTION statement_extractions_guard();

-- Lines: insert/update/delete only while the parent is open; except that
-- approval may stamp nothing on them (posting is recorded in staged_transactions).
CREATE FUNCTION extraction_lines_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_status extraction_status;
  parent_id uuid;
  parent_biz uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.extraction_id; parent_biz := OLD.business_id;
  ELSE
    parent_id := NEW.extraction_id; parent_biz := NEW.business_id;
  END IF;
  SELECT status INTO parent_status FROM statement_extractions
    WHERE business_id = parent_biz AND id = parent_id;
  IF parent_status IS NULL OR parent_status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'lines of a % extraction cannot change', coalesce(parent_status::text, 'missing')
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER extraction_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON extraction_lines
  FOR EACH ROW EXECUTE FUNCTION extraction_lines_guard();

CREATE TRIGGER statement_extractions_no_truncate BEFORE TRUNCATE ON statement_extractions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER extraction_lines_no_truncate BEFORE TRUNCATE ON extraction_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ------------------------------------------------------------------ RLS
-- Same pattern as every other tenant table: enabled AND forced, one policy on app.business_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['statement_extractions','extraction_lines']
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
-- As in 0003/0004/0006, audit rows (extraction.create / .update / .approve /
-- .reject) are written by the application in the same transaction.

-- --------------------------------------------------------------- grants
-- No DELETE on extractions. Lines may be deleted (the trigger limits that to
-- open extractions) because a correction replaces the line set.
GRANT SELECT, INSERT, UPDATE ON statement_extractions TO riffle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON extraction_lines TO riffle_app;
