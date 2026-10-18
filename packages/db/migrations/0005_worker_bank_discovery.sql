-- 0005_worker_bank_discovery.sql
-- Phase 3: lets the background worker discover which bank connections exist.
-- See docs/adr/0009-simplefin-import.md (addendum) and docs/worker-import.md.
--
-- Row-level security confines `riffle_app` to one business per transaction, so
-- the worker cannot list connections across tenants. This SECURITY DEFINER
-- function returns the scheduling metadata only. It deliberately does NOT
-- return access_url_enc, access_url_key_id, label or last_error. Everything
-- after discovery (decrypt, fetch, stage) runs under withTenant() with RLS.

-- bank_connections is FORCE ROW LEVEL SECURITY, and its only policy targets
-- riffle_app, so even the table owner sees no rows. Give the owner (the role
-- running this migration, and therefore the function owner) a read-only policy.
-- A superuser owner bypasses RLS anyway, which makes this a no-op there.
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY worker_discovery ON bank_connections FOR SELECT TO %I USING (true)',
    current_user);
END
$$;

CREATE FUNCTION riffle_worker_bank_connections(p_id uuid DEFAULT NULL)
  RETURNS TABLE (
    id              uuid,
    business_id     uuid,
    created_by      uuid,
    status          bank_connection_status,
    last_synced_at  timestamptz,
    updated_at      timestamptz,
    schedule_minute smallint
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.business_id, c.created_by, c.status, c.last_synced_at, c.updated_at, c.schedule_minute
    FROM public.bank_connections c
   WHERE p_id IS NULL OR c.id = p_id
   ORDER BY c.id
$$;

REVOKE ALL ON FUNCTION riffle_worker_bank_connections(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION riffle_worker_bank_connections(uuid) TO riffle_app;
