-- Durable BFF auth. The web role only executes reviewed functions, while their
-- dedicated non-owner, non-superuser definer can access auth metadata alone.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hostline_auth') THEN
    CREATE ROLE hostline_auth NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hostline_auth_broker') THEN
    CREATE ROLE hostline_auth_broker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT hostline_auth_broker TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO hostline_auth_broker;
GRANT USAGE ON SCHEMA public TO hostline_auth;
-- Only non-sensitive migration version metadata is directly readable.
GRANT SELECT ON schema_migrations TO hostline_auth;

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY, issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
  version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL,
  UNIQUE(issuer,subject)
);
CREATE TABLE auth_tenant_access (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(tenant_id),
  version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL,
  workspace_name text NOT NULL CHECK(length(workspace_name) BETWEEN 1 AND 100)
);
CREATE TABLE auth_memberships (
  tenant_id uuid NOT NULL REFERENCES auth_tenant_access(tenant_id),
  identity_id uuid NOT NULL REFERENCES auth_identities(id),
  version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','staff','viewer')),
  PRIMARY KEY(tenant_id,identity_id)
);
-- Pre-tenant discovery sees opaque routes only, then repeats scoped authority.
CREATE TABLE auth_membership_routes (
  identity_id uuid NOT NULL, tenant_id uuid NOT NULL,
  PRIMARY KEY(identity_id,tenant_id),
  FOREIGN KEY(tenant_id,identity_id) REFERENCES auth_memberships(tenant_id,identity_id)
);
CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'), id uuid NOT NULL UNIQUE,
  identity_id uuid NOT NULL, tenant_id uuid NOT NULL,
  issuer text NOT NULL, client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 255),
  identity_version integer NOT NULL CHECK(identity_version>0),
  membership_version integer NOT NULL CHECK(membership_version>0),
  tenant_version integer NOT NULL CHECK(tenant_version>0),
  login_token_hash text NOT NULL UNIQUE CHECK(login_token_hash ~ '^[a-f0-9]{64}$'),
  login_redirect_uri text NOT NULL CHECK(length(login_redirect_uri) BETWEEN 1 AND 2048),
  mfa_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL,
  FOREIGN KEY(tenant_id,identity_id) REFERENCES auth_memberships(tenant_id,identity_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '8 hours'),
  CHECK(idle_expires_at<=expires_at),
  CHECK(mfa_verified_at IS NULL OR mfa_verified_at<=created_at+interval '1 minute')
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_identity_idx ON auth_sessions(identity_id);
CREATE TABLE auth_login_attempts (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 255),
  redirect_uri text NOT NULL CHECK(length(redirect_uri) BETWEEN 1 AND 2048),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','CLAIMED','COMPLETED','CANCELLED')),
  encrypted_payload text CHECK(length(encrypted_payload) BETWEEN 1 AND 16384),
  CHECK((state='PENDING')=(encrypted_payload IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
CREATE INDEX auth_login_attempts_expiry_idx ON auth_login_attempts(expires_at);
CREATE TABLE auth_operator_events (
  tenant_id uuid NOT NULL REFERENCES auth_tenant_access(tenant_id), id uuid NOT NULL, identity_id uuid REFERENCES auth_identities(id),
  action text NOT NULL DEFAULT 'identity.provisioned' CHECK(action IN('identity.provisioned','restaurant.provisioned')),
  identity_version integer, membership_version integer, tenant_version integer NOT NULL,
  restaurant_version integer CHECK(restaurant_version>0),
  CHECK((action='identity.provisioned' AND identity_id IS NOT NULL AND identity_version IS NOT NULL AND membership_version IS NOT NULL AND identity_version>0 AND membership_version>0) OR (action='restaurant.provisioned' AND restaurant_version IS NOT NULL AND identity_id IS NULL)),
  operator_role text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);

DO $$ DECLARE ref uuid; previous_tenant text; BEGIN
  previous_tenant:=current_setting('hostline.tenant_id',true);
  FOR ref IN SELECT id FROM tenant_registry LOOP
    PERFORM set_config('hostline.tenant_id',ref::text,true);
    INSERT INTO auth_tenant_access(tenant_id,version,enabled,workspace_name)
      SELECT tenant_id,1,true,document->>'name' FROM restaurants WHERE tenant_id=ref;
  END LOOP;
  PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true);
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['auth_identities','auth_membership_routes','auth_sessions','auth_login_attempts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY auth_broker_only ON %I TO hostline_auth_broker USING (true) WITH CHECK (true)',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['auth_tenant_access','auth_memberships','auth_operator_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''hostline.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''hostline.tenant_id'',true),'''')::uuid)',table_name);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON auth_identities,auth_membership_routes,auth_sessions,auth_login_attempts,auth_tenant_access,auth_memberships TO hostline_auth_broker;
GRANT SELECT,INSERT ON auth_operator_events TO hostline_auth_broker;
GRANT SELECT ON auth_tenant_access TO hostline_app;

-- All session/provision/revoke operations lock identity then tenant advisory
-- keys, then rows; authorizations admitted first may finish before revocation.
CREATE FUNCTION auth_read_session(p_hash text,p_issuer text,p_client text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.auth_sessions%ROWTYPE; i public.auth_identities%ROWTYPE;
  m public.auth_memberships%ROWTYPE; t public.auth_tenant_access%ROWTYPE;
  previous_tenant text;
BEGIN
  SELECT * INTO s FROM public.auth_sessions WHERE token_hash=p_hash AND issuer=p_issuer AND client_id=p_client;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth_identity:'||s.identity_id::text,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth_tenant:'||s.tenant_id::text,0));
  SELECT * INTO i FROM public.auth_identities WHERE id=s.identity_id FOR SHARE;
  previous_tenant:=current_setting('hostline.tenant_id',true);
  PERFORM set_config('hostline.tenant_id',s.tenant_id::text,true);
  SELECT * INTO t FROM public.auth_tenant_access WHERE tenant_id=s.tenant_id FOR SHARE;
  SELECT * INTO m FROM public.auth_memberships WHERE tenant_id=s.tenant_id AND identity_id=s.identity_id FOR SHARE;
  -- This reread locks the session only after identity/tenant/membership locks.
  SELECT * INTO s FROM public.auth_sessions WHERE token_hash=p_hash AND issuer=p_issuer AND client_id=p_client FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(i.enabled,false) OR NOT coalesce(t.enabled,false) OR NOT coalesce(m.enabled,false)
    OR i.issuer<>p_issuer OR i.version<>s.identity_version OR t.version<>s.tenant_version OR m.version<>s.membership_version
    OR s.expires_at<=now() OR s.idle_expires_at<=now() THEN
    PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true); RETURN NULL;
  END IF;
  UPDATE public.auth_sessions SET idle_expires_at=least(expires_at,now()+interval '30 minutes') WHERE token_hash=p_hash RETURNING * INTO s;
  PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true);
  RETURN jsonb_build_object('sessionId',s.id,'identityId',i.id,'tenantId',s.tenant_id,'role',m.role,
    'displayName',i.display_name,'workspaceName',t.workspace_name,'expiresAt',s.expires_at,
    'idleExpiresAt',s.idle_expires_at,'mfaVerifiedAt',s.mfa_verified_at,
    'identityVersion',i.version,'membershipVersion',m.version,'tenantVersion',t.version);
END $$;

CREATE FUNCTION auth_issue_session(p_hash text,p_id uuid,p_issuer text,p_client text,p_subject text,p_tenant uuid,p_expiry timestamptz,p_mfa timestamptz,p_login_hash text,p_redirect text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i public.auth_identities%ROWTYPE; m public.auth_memberships%ROWTYPE;
  t public.auth_tenant_access%ROWTYPE; ref uuid; chosen uuid; matches integer:=0;
  previous_tenant text; attempt public.auth_login_attempts%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM public.auth_login_attempts WHERE token_hash=p_login_hash AND issuer=p_issuer AND client_id=p_client AND redirect_uri=p_redirect FOR UPDATE;
  IF NOT FOUND OR attempt.state<>'CLAIMED' OR attempt.expires_at<=now() THEN RETURN NULL; END IF;
  IF p_expiry<=now() OR p_expiry>now()+interval '8 hours' OR p_mfa>now()+interval '1 minute' THEN RETURN NULL; END IF;
  SELECT * INTO i FROM public.auth_identities WHERE issuer=p_issuer AND subject=p_subject;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth_identity:'||i.id::text,0));
  SELECT * INTO i FROM public.auth_identities WHERE id=i.id FOR SHARE;
  IF NOT i.enabled THEN RETURN NULL; END IF;
  previous_tenant:=current_setting('hostline.tenant_id',true);
  FOR ref IN SELECT tenant_id FROM public.auth_membership_routes WHERE identity_id=i.id AND (p_tenant IS NULL OR tenant_id=p_tenant) ORDER BY tenant_id LIMIT 101 LOOP
    PERFORM set_config('hostline.tenant_id',ref::text,true);
    IF EXISTS(SELECT FROM public.auth_memberships am JOIN public.auth_tenant_access at ON at.tenant_id=am.tenant_id
      WHERE am.identity_id=i.id AND am.tenant_id=ref AND am.enabled AND at.enabled) THEN
      chosen:=ref; matches:=matches+1;
    END IF;
  END LOOP;
  IF matches<>1 THEN PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true); RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth_tenant:'||chosen::text,0));
  PERFORM set_config('hostline.tenant_id',chosen::text,true);
  SELECT * INTO t FROM public.auth_tenant_access WHERE tenant_id=chosen FOR SHARE;
  SELECT * INTO m FROM public.auth_memberships WHERE tenant_id=chosen AND identity_id=i.id FOR SHARE;
  IF NOT coalesce(t.enabled,false) OR NOT coalesce(m.enabled,false) THEN
    PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true); RETURN NULL;
  END IF;
  -- A fixed cap bounds durable storage; expiry pruning is bounded per operation.
  PERFORM pg_advisory_xact_lock(873622021);
  DELETE FROM public.auth_sessions WHERE token_hash IN (SELECT token_hash FROM public.auth_sessions WHERE expires_at<=now() OR idle_expires_at<=now() ORDER BY expires_at LIMIT 100);
  IF (SELECT count(*) FROM public.auth_sessions)>=100000 OR (SELECT count(*) FROM public.auth_sessions WHERE identity_id=i.id)>=50 THEN
    PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true); RETURN NULL;
  END IF;
  INSERT INTO public.auth_sessions(token_hash,id,identity_id,tenant_id,issuer,client_id,identity_version,membership_version,tenant_version,mfa_verified_at,expires_at,idle_expires_at,login_token_hash,login_redirect_uri)
    VALUES(p_hash,p_id,i.id,chosen,p_issuer,p_client,i.version,m.version,t.version,p_mfa,p_expiry,least(p_expiry,now()+interval '30 minutes'),p_login_hash,p_redirect);
  UPDATE public.auth_login_attempts SET state='COMPLETED' WHERE token_hash=p_login_hash;
  PERFORM set_config('hostline.tenant_id',coalesce(previous_tenant,''),true);
  RETURN public.auth_read_session(p_hash,p_issuer,p_client);
END $$;

CREATE FUNCTION auth_revoke_session(p_hash text,p_issuer text,p_client text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.auth_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.auth_sessions WHERE token_hash=p_hash AND issuer=p_issuer AND client_id=p_client;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth_identity:'||s.identity_id::text,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth_tenant:'||s.tenant_id::text,0));
  DELETE FROM public.auth_sessions WHERE token_hash=p_hash AND issuer=p_issuer AND client_id=p_client;
END $$;

CREATE FUNCTION auth_create_login(p_hash text,p_issuer text,p_client text,p_redirect text,p_payload text,p_expiry timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF p_expiry<=now() OR p_expiry>now()+interval '5 minutes' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(873622022);
  DELETE FROM public.auth_login_attempts WHERE token_hash IN(SELECT token_hash FROM public.auth_login_attempts WHERE expires_at<=now() ORDER BY expires_at LIMIT 100);
  IF (SELECT count(*) FROM public.auth_login_attempts)>=10000 OR
    (SELECT count(*) FROM public.auth_login_attempts WHERE issuer=p_issuer AND client_id=p_client)>=1000 THEN RETURN false; END IF;
  INSERT INTO public.auth_login_attempts(token_hash,issuer,client_id,redirect_uri,encrypted_payload,expires_at)
    VALUES(p_hash,p_issuer,p_client,p_redirect,p_payload,p_expiry);
  RETURN true;
END $$;
CREATE FUNCTION auth_consume_login(p_hash text,p_issuer text,p_client text,p_redirect text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE consumed public.auth_login_attempts%ROWTYPE;
BEGIN
  SELECT * INTO consumed FROM public.auth_login_attempts WHERE token_hash=p_hash AND issuer=p_issuer AND client_id=p_client AND redirect_uri=p_redirect FOR UPDATE;
  IF NOT FOUND OR consumed.state<>'PENDING' OR consumed.expires_at<=now() THEN RETURN NULL; END IF;
  UPDATE public.auth_login_attempts SET state='CLAIMED',encrypted_payload=NULL WHERE token_hash=p_hash;
  RETURN jsonb_build_object('encryptedPayload',consumed.encrypted_payload,'expiresAt',consumed.expires_at);
END $$;

CREATE FUNCTION auth_cancel_login(p_hash text,p_issuer text,p_client text,p_redirect text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  UPDATE public.auth_login_attempts SET state='CANCELLED',encrypted_payload=NULL
    WHERE token_hash=p_hash AND issuer=p_issuer AND client_id=p_client AND redirect_uri=p_redirect;
  -- The session retains binding after bounded login-attempt expiry pruning.
  DELETE FROM public.auth_sessions WHERE login_token_hash=p_hash AND issuer=p_issuer AND client_id=p_client AND login_redirect_uri=p_redirect;
END $$;

CREATE FUNCTION auth_read_tenant_access(p_tenant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.auth_tenant_access%ROWTYPE;
BEGIN
  IF p_tenant::text IS DISTINCT FROM nullif(current_setting('hostline.tenant_id',true),'') THEN RETURN NULL; END IF;
  SELECT * INTO t FROM public.auth_tenant_access WHERE tenant_id=p_tenant FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('version',t.version,'enabled',t.enabled,'workspaceName',t.workspace_name);
END $$;
ALTER FUNCTION auth_read_tenant_access(uuid) OWNER TO hostline_auth_broker;
REVOKE ALL ON FUNCTION auth_read_tenant_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_read_tenant_access(uuid) TO hostline_app;

DO $$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'auth_read_session(text,text,text)',
    'auth_issue_session(text,uuid,text,text,text,uuid,timestamp with time zone,timestamp with time zone,text,text)',
    'auth_revoke_session(text,text,text)',
    'auth_create_login(text,text,text,text,text,timestamp with time zone)',
    'auth_consume_login(text,text,text,text)',
    'auth_cancel_login(text,text,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hostline_auth_broker',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hostline_auth',signature);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM hostline_auth_broker;
INSERT INTO schema_migrations(version) VALUES(4);
