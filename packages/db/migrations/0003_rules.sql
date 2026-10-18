-- 0003_rules.sql
-- Phase 2: per-business categorisation rules. See docs/adr/0007-rules-engine.md.
--
-- A rule is metadata about how to treat transactions; it never touches posted
-- journal lines. Recategorising goes through the edit-by-reversal ledger
-- operation, so history stays append-only (ADR 0004).

CREATE TABLE rules (
  id          uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses (id),
  name        text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  -- Lower runs first. Ties keep creation order (ids are UUIDv7).
  priority    integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 100000),
  -- true: ALL conditions must match. false: ANY condition may match.
  strict      boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT true,
  -- Shapes are validated by the application (packages/db/src/rules/definition.ts);
  -- the database only guarantees they are non-empty, bounded arrays.
  conditions  jsonb NOT NULL
    CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) BETWEEN 1 AND 20),
  actions     jsonb NOT NULL
    CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 10),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX rules_business_priority_idx ON rules (business_id, priority, id);

-- Tags applied to transactions (by rules or by hand). Mutable metadata, like
-- transactions.notes; not part of the ledger.
CREATE TABLE transaction_tags (
  business_id    uuid NOT NULL REFERENCES businesses (id),
  transaction_id uuid NOT NULL,
  tag            text NOT NULL CHECK (length(tag) BETWEEN 1 AND 40 AND tag = lower(btrim(tag))),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, transaction_id, tag),
  FOREIGN KEY (business_id, transaction_id) REFERENCES transactions (business_id, id)
);
CREATE INDEX transaction_tags_tag_idx ON transaction_tags (business_id, tag);

-- ------------------------------------------------------------------ RLS
-- Same pattern as every other tenant table in 0001: enabled AND forced, one
-- policy keyed on app.business_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rules','transaction_tags']
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
-- Audit rows are written by the application in the same transaction as the
-- change (rule.create / rule.update / rule.delete / transaction.rule_apply),
-- as for every other entity. A trigger is deliberately not used: audit_log ids
-- are UUIDv7 (the audit API paginates on id order) and are minted in the app.
-- A rule's before/after JSON is stored in audit_log, so DELETE is safe.

-- --------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE, DELETE ON rules TO riffle_app;
GRANT SELECT, INSERT, DELETE ON transaction_tags TO riffle_app;
