-- =============================================================================
-- Mission Control Username/Password Authentication Schema & RPCs
-- =============================================================================
-- Persists registered operator accounts across Render deployments.
-- Passwords are hashed database-side using pgcrypto blowfish (crypt + gen_salt('bf', 12)).
-- Phone number is optional profile metadata only (no SMS or OTP verification).
-- Both RPCs enforce backend-only access via service_role or shared secret header.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.mission_control_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mission_control_users_username_lower_idx
  ON public.mission_control_users (LOWER(username));

ALTER TABLE public.mission_control_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mission_control_users FROM PUBLIC, anon, authenticated;

-- Optional table to hold the backend shared secret hash when GUC settings are restricted
CREATE TABLE IF NOT EXISTS private_mc_config (
  key TEXT PRIMARY KEY,
  value_hash TEXT NOT NULL
);
REVOKE ALL ON TABLE private_mc_config FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mc_assert_backend_authorized()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role TEXT;
  v_headers JSONB;
  v_provided TEXT;
  v_expected TEXT;
  v_expected_hash TEXT;
BEGIN
  v_role := coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );

  IF v_role = 'service_role' THEN
    RETURN;
  END IF;

  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_provided := coalesce(
    v_headers ->> 'x-mc-backend-secret',
    v_headers ->> 'x-mc-auth-secret',
    v_headers ->> 'x-mc-secret',
    v_headers ->> 'x-mission-control-secret',
    v_headers ->> 'x-backend-secret',
    v_headers ->> 'x-auth-secret',
    ''
  );

  v_expected := coalesce(
    nullif(current_setting('app.settings.mc_backend_secret', true), ''),
    nullif(current_setting('app.mc_backend_secret', true), ''),
    ''
  );

  IF v_provided <> '' AND v_expected <> '' AND v_provided = v_expected THEN
    RETURN;
  END IF;

  SELECT value_hash INTO v_expected_hash
  FROM private_mc_config
  WHERE key = 'mc_backend_secret'
  LIMIT 1;

  IF v_provided <> '' AND v_expected_hash IS NOT NULL
     AND extensions.crypt(v_provided, v_expected_hash) = v_expected_hash THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Unauthorized backend request' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.mc_assert_backend_authorized() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mc_register_user(
  p_username TEXT,
  p_password TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  username TEXT,
  phone TEXT,
  role TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_username TEXT := btrim(coalesce(p_username, ''));
  v_password TEXT := coalesce(p_password, '');
  v_phone TEXT := nullif(btrim(coalesce(p_phone, '')), '');
BEGIN
  PERFORM public.mc_assert_backend_authorized();

  IF length(v_username) < 3 OR length(v_username) > 32 THEN
    RAISE EXCEPTION 'Username must be between 3 and 32 characters' USING ERRCODE = '22023';
  END IF;

  IF length(v_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.mission_control_users u WHERE lower(u.username) = lower(v_username)
  ) THEN
    RAISE EXCEPTION 'Username already exists' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
  INSERT INTO public.mission_control_users (username, password_hash, phone, role)
  VALUES (
    v_username,
    extensions.crypt(v_password, extensions.gen_salt('bf', 12)),
    v_phone,
    'operator'
  )
  RETURNING
    mission_control_users.id,
    mission_control_users.username,
    mission_control_users.phone,
    mission_control_users.role,
    mission_control_users.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.mc_authenticate_user(
  p_username TEXT,
  p_password TEXT
)
RETURNS TABLE (
  id UUID,
  username TEXT,
  phone TEXT,
  role TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_username TEXT := btrim(coalesce(p_username, ''));
  v_password TEXT := coalesce(p_password, '');
BEGIN
  PERFORM public.mc_assert_backend_authorized();

  RETURN QUERY
  SELECT
    u.id,
    u.username,
    u.phone,
    u.role,
    u.created_at
  FROM public.mission_control_users u
  WHERE lower(u.username) = lower(v_username)
    AND u.password_hash = extensions.crypt(v_password, u.password_hash)
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mc_register_user(TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mc_authenticate_user(TEXT, TEXT) TO anon, authenticated, service_role;
