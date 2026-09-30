-- Additive operations tables. Deploy this migration before the operations-aware
-- API. Existing restaurants receive permissive policy switches; deployment
-- flags remain the ceiling and continue to default off. Backfill inserts one
-- small row per restaurant without rewriting calls or control tombstones.
CREATE TABLE phone_policies (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(tenant_id),
  version integer NOT NULL CHECK (version > 0),
  voice_enabled boolean NOT NULL,
  requests_enabled boolean NOT NULL,
  transfers_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  CHECK (
    jsonb_typeof(document) = 'object' AND
    document - ARRAY['version','voiceEnabled','requestsEnabled','transfersEnabled','updatedAt'] = '{}'::jsonb AND
    ((document->>'version')::integer = version) IS TRUE AND
    (document->'voiceEnabled' = to_jsonb(voice_enabled)) IS TRUE AND
    (document->'requestsEnabled' = to_jsonb(requests_enabled)) IS TRUE AND
    (document->'transfersEnabled' = to_jsonb(transfers_enabled)) IS TRUE AND
    ((document->>'updatedAt')::timestamptz = updated_at) IS TRUE
  )
);
-- Restaurant content already has FORCE RLS. Iterate only opaque registry IDs
-- and enter each tenant context so this backfill needs no BYPASSRLS identity.
DO $$ DECLARE tenant_ref uuid; previous_tenant text; BEGIN
  previous_tenant := current_setting('hostline.tenant_id', true);
  FOR tenant_ref IN SELECT id FROM tenant_registry ORDER BY id LOOP
    PERFORM set_config('hostline.tenant_id',tenant_ref::text,true);
    INSERT INTO phone_policies (
      tenant_id,version,voice_enabled,requests_enabled,transfers_enabled,updated_at,document
    )
    SELECT tenant_id,1,true,true,true,date_trunc('milliseconds',now()),jsonb_build_object(
      'version',1,'voiceEnabled',true,'requestsEnabled',true,'transfersEnabled',true,
      'updatedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) FROM restaurants WHERE tenant_id=tenant_ref;
  END LOOP;
  PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true);
END $$;

CREATE TABLE phone_handoffs (
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  control_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('requested_staff','allergy_question','other')),
  summary text NOT NULL CHECK (length(summary) <= 300),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (tenant_id,call_id),
  FOREIGN KEY (tenant_id,call_id) REFERENCES voice_calls(tenant_id,id),
  CHECK (
    jsonb_typeof(document) = 'object' AND
    document - ARRAY['callId','controlId','reason','summary','createdAt'] = '{}'::jsonb AND
    (document->>'callId' = call_id::text) IS TRUE AND
    (document->>'controlId' = control_id::text) IS TRUE AND
    (document->>'reason' = reason) IS TRUE AND
    (document->'summary' = to_jsonb(summary)) IS TRUE AND
    ((document->>'createdAt')::timestamptz = created_at) IS TRUE
  )
);

ALTER TABLE phone_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON phone_policies
  USING (tenant_id = nullif(current_setting('hostline.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('hostline.tenant_id', true), '')::uuid);
ALTER TABLE phone_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON phone_handoffs
  USING (tenant_id = nullif(current_setting('hostline.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('hostline.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON phone_policies, phone_handoffs TO hostline_app;
-- No public, deletion, or worker privileges. Existing provider recovery records
-- are retained; dropping these tables is not a safe recovery procedure.
INSERT INTO schema_migrations(version) VALUES (3);
