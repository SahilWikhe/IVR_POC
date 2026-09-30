-- Additive, empty-table migration. Apply before starting the voice-aware API.
-- Existing call/inbox rows are unchanged; replay tombstones are retained until
-- a separately reviewed retention policy can prove deletion will remain safe.
CREATE TABLE voice_calls (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  provider_call_sid text NOT NULL CHECK (provider_call_sid ~ '^CA[0-9a-fA-F]{32}$'),
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN (
    'WAITING_FOR_STREAM','STREAMING','CONTROL_PENDING','AWAITING_CONFIRMATION',
    'TRANSFER_PENDING','TRANSFERRING','CONNECTED_TO_STAFF','NEEDS_RECONCILIATION','ENDED'
  )),
  generation uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_call_sid),
  FOREIGN KEY (tenant_id, id) REFERENCES calls(tenant_id, id),
  CHECK (
    jsonb_typeof(document) = 'object' AND
    (document->>'id' = id::text) IS TRUE AND
    (document->>'providerCallSid' = provider_call_sid) IS TRUE AND
    ((document->>'version')::integer = version) IS TRUE AND
    (document->>'state' = state) IS TRUE AND
    (document->>'generation' = generation::text) IS TRUE AND
    ((document->>'leaseExpiresAt')::timestamptz = lease_expires_at) IS TRUE AND
    (document->>'accountSid' ~ '^AC[0-9a-fA-F]{32}$') IS TRUE
  )
);
CREATE INDEX voice_calls_admission_idx ON voice_calls (tenant_id, lease_expires_at)
  WHERE state <> 'ENDED';

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_calls
  USING (tenant_id = nullif(current_setting('hostline.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('hostline.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON voice_calls TO hostline_app;
-- The worker has no raw phone-control read or mutation privileges. Tenant data
-- reaches the gateway only through the authenticated internal API protocol.
INSERT INTO schema_migrations(version) VALUES (2);
