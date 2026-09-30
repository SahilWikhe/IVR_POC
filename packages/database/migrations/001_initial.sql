-- Apply with a dedicated migration role. Runtime connections must be members of
-- hostline_app and hostline_worker, never owners of these tables. No migration
-- runs automatically when a PostgreSQL-backed web process starts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hostline_app') THEN
    CREATE ROLE hostline_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hostline_worker') THEN
    CREATE ROLE hostline_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Provisioning registry contains opaque routing references only; runtime roles
-- cannot read it. The bounded worker discovery function is the only read path.
CREATE TABLE IF NOT EXISTS tenant_registry (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS restaurants (
  tenant_id uuid PRIMARY KEY REFERENCES tenant_registry(id),
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document) = 'object' AND
    (document->>'id' = tenant_id::text) IS TRUE AND
    ((document->>'version')::integer = version) IS TRUE
  )
);
CREATE TABLE IF NOT EXISTS calls (
  tenant_id uuid NOT NULL REFERENCES restaurants(tenant_id),
  id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK ((document->>'id' = id::text) IS TRUE AND ((document->>'version')::integer = version) IS TRUE)
);
CREATE TABLE IF NOT EXISTS inbox (
  tenant_id uuid NOT NULL REFERENCES restaurants(tenant_id),
  id uuid NOT NULL, call_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('PENDING_STAFF_REVIEW','ACKNOWLEDGED','IN_REVIEW','IN_FULFILLMENT','BOOKED_AWAITING_GUEST_NOTICE','DECLINED_AWAITING_GUEST_NOTICE','NEEDS_RECONCILIATION','CLOSED')),
  lease_expires_at timestamptz, created_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls(tenant_id, id),
  CHECK ((document->>'id' = id::text) IS TRUE AND (document->>'callId' = call_id::text) IS TRUE AND
    ((document->>'version')::integer = version) IS TRUE AND (document->>'state' = state) IS TRUE)
);
CREATE TABLE IF NOT EXISTS receipts (
  tenant_id uuid NOT NULL REFERENCES restaurants(tenant_id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 250),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 250),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id uuid NOT NULL REFERENCES restaurants(tenant_id), id uuid NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 250),
  action text NOT NULL CHECK (action ~ '^[a-zA-Z0-9_.:-]{1,100}$'),
  resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS outbox (
  tenant_id uuid NOT NULL REFERENCES restaurants(tenant_id), id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-zA-Z0-9_.:-]{1,100}$'),
  resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS jobs (
  tenant_id uuid NOT NULL, id uuid NOT NULL, outbox_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','complete','quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_expires_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, outbox_id),
  FOREIGN KEY (tenant_id, outbox_id) REFERENCES outbox(tenant_id, id),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS inbox_created_idx ON inbox (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbox_expiry_idx ON inbox (tenant_id, lease_expires_at)
  WHERE state IN ('IN_REVIEW','IN_FULFILLMENT');
CREATE INDEX IF NOT EXISTS calls_created_idx ON calls (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (tenant_id, next_run_at)
  WHERE state IN ('pending','leased');

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['restaurants','calls','inbox','receipts','audit_events','outbox','jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''hostline.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''hostline.tenant_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO hostline_app, hostline_worker;
GRANT SELECT, INSERT, UPDATE ON restaurants, calls, inbox, jobs TO hostline_app;
GRANT SELECT, INSERT ON receipts, audit_events, outbox TO hostline_app;

-- Iterate opaque registry references while respecting FORCE RLS on content.
-- Worker gets only refs; all actual work must re-enter a tenant transaction.
CREATE FUNCTION discover_work(batch_limit integer)
RETURNS TABLE(tenant_id uuid, resource_id uuid, work_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE tenant_ref uuid; previous_tenant text; remaining integer; returned_count integer;
BEGIN
  remaining := least(greatest(batch_limit, 1), 100);
  previous_tenant := current_setting('hostline.tenant_id', true);
  FOR tenant_ref IN SELECT id FROM public.tenant_registry ORDER BY id LOOP
    PERFORM set_config('hostline.tenant_id', tenant_ref::text, true);
    RETURN QUERY SELECT j.tenant_id, j.id, 'job'::text FROM public.jobs j
      WHERE j.tenant_id = tenant_ref AND
      ((j.state = 'pending' AND j.next_run_at <= now()) OR
       (j.state = 'leased' AND j.lease_expires_at <= now()))
      ORDER BY j.next_run_at LIMIT remaining;
    GET DIAGNOSTICS returned_count = ROW_COUNT;
    remaining := remaining - returned_count;
    EXIT WHEN remaining <= 0;
    RETURN QUERY SELECT i.tenant_id, i.id, 'fulfillment'::text FROM public.inbox i
      WHERE i.tenant_id = tenant_ref AND i.state IN ('IN_REVIEW','IN_FULFILLMENT')
      AND i.lease_expires_at <= now() ORDER BY i.lease_expires_at LIMIT remaining;
    GET DIAGNOSTICS returned_count = ROW_COUNT;
    remaining := remaining - returned_count;
    EXIT WHEN remaining <= 0;
  END LOOP;
  PERFORM set_config('hostline.tenant_id', coalesce(previous_tenant,''), true);
END $$;
REVOKE ALL ON FUNCTION discover_work(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_work(integer) TO hostline_worker;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES (1);
