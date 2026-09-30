-- Caller-content minimization is explicitly configured and off when no policy
-- exists. Its operator role is separate from ordinary API/worker identities.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hostline_privacy') THEN
    CREATE ROLE hostline_privacy NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO hostline_privacy;

ALTER TABLE receipts ADD COLUMN resource_call_id uuid;
ALTER TABLE receipts ADD CONSTRAINT receipts_resource_call_fk
  FOREIGN KEY (tenant_id,resource_call_id) REFERENCES calls(tenant_id,id);
CREATE INDEX receipts_resource_call_idx ON receipts(tenant_id,resource_call_id);

CREATE TABLE privacy_policies (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(tenant_id),
  version integer NOT NULL CHECK(version>0),
  document jsonb NOT NULL,
  CHECK(jsonb_typeof(document)='object' AND
    ((document->>'version')::integer=version) IS TRUE)
);
CREATE TABLE privacy_holds (
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,call_id),
  FOREIGN KEY(tenant_id,call_id) REFERENCES calls(tenant_id,id)
);
CREATE TABLE privacy_decisions (
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  event_id uuid NOT NULL,
  document jsonb NOT NULL,
  admitted_at timestamptz,
  admitted_policy_version bigint CHECK(admitted_policy_version>0),
  journal_sequence bigint CHECK(journal_sequence>0),
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,call_id),
  UNIQUE(tenant_id,event_id),
  FOREIGN KEY(tenant_id,call_id) REFERENCES calls(tenant_id,id),
  CHECK(jsonb_typeof(document)='object' AND
    (document->>'tenantId'=tenant_id::text) IS TRUE AND
    (document->>'callId'=call_id::text) IS TRUE AND
    (document->>'eventId'=event_id::text) IS TRUE AND
    ((admitted_at IS NULL)=(admitted_policy_version IS NULL)) AND
    (completed_at IS NULL OR (journal_sequence IS NOT NULL AND admitted_at IS NOT NULL)))
);
CREATE TABLE recovery_checkpoints (
  installation_id uuid PRIMARY KEY,
  epoch uuid NOT NULL,
  database_resource_id text NOT NULL CHECK(length(database_resource_id) BETWEEN 1 AND 200),
  security_version bigint NOT NULL CHECK(security_version>0),
  applied_through_sequence bigint NOT NULL CHECK(applied_through_sequence>=0),
  updated_at timestamptz NOT NULL
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['privacy_policies','privacy_holds','privacy_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''hostline.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''hostline.tenant_id'',true),'''')::uuid)',table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON privacy_policies,privacy_holds,privacy_decisions TO hostline_privacy;
GRANT SELECT, UPDATE ON calls,inbox,voice_calls,phone_handoffs,receipts TO hostline_privacy;
GRANT SELECT, INSERT, UPDATE ON recovery_checkpoints TO hostline_privacy;
GRANT SELECT ON recovery_checkpoints TO hostline_app,hostline_worker;
GRANT SELECT ON schema_migrations TO hostline_privacy,hostline_worker;

-- Match the application lock order without giving the privacy operator general
-- restaurant configuration write privileges. FORCE RLS still applies to owner.
CREATE FUNCTION lock_privacy_tenant(tenant_ref uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $$ BEGIN
  IF tenant_ref IS DISTINCT FROM nullif(current_setting('hostline.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Invalid privacy tenant context' USING ERRCODE='42501';
  END IF;
  PERFORM tenant_id FROM public.restaurants WHERE tenant_id=tenant_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Privacy tenant unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION lock_privacy_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_privacy_tenant(uuid) TO hostline_privacy;
INSERT INTO schema_migrations(version) VALUES(5);
