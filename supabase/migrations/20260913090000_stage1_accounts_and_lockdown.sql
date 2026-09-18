/*
# Stage 1 — accounts, server-side auth, and database lockdown

## Why
Participants are about to use this app. Until now every table accepted reads
AND writes from the public anon key, which ships inside the page JavaScript.
Anyone with a browser devtools console could pause the event timer, send
venue-wide alerts, or read the admin PIN hash.

After this migration:
  - the anon key can only READ display-safe data (timer, alerts, displays,
    batches) — nothing it can change
  - every write goes through server API routes using the service-role key
  - credentials and device secrets live in tables the anon key cannot see

## New tables (server-only: RLS on, no policies, privileges revoked)
- accounts             one row per person: admin / operator / participant,
                       personal ID + PBKDF2 PIN hash
- auth_settings        single row; session_epoch ends every session at once
- auth_login_attempts  login + pairing attempts, for rate limiting
- display_credentials  per-display pairing code and device token (hashed)

## Changed
- event_control_state.pin_hash is DROPPED. The shared admin PIN is replaced
  by personal admin accounts. Create the first one with `npm run create-admin`
  BEFORE restarting the app, or nobody can sign in.
- event_alerts gains created_by (the account that sent it).
- All insert/update/delete policies on the existing tables are removed.
- event_audit_logs is no longer readable with the anon key.

## Apply order
1. Add SUPABASE_SERVICE_ROLE_KEY and SESSION_SECRET to .env
2. Run this migration
3. npm run create-admin
4. Restart the app
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       text NOT NULL CHECK (account_id ~ '^[A-Z0-9][A-Z0-9._-]{1,39}$'),
  role             text NOT NULL CHECK (role IN ('admin', 'operator', 'participant')),
  display_name     text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  pin_hash         text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  session_version  integer NOT NULL DEFAULT 1,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- IDs are stored upper-case by the app; this keeps them unique regardless.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_id_key ON public.accounts (upper(account_id));
CREATE INDEX IF NOT EXISTS accounts_role_idx ON public.accounts (role);

-- ---------------------------------------------------------------------------
-- auth_settings (single row)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_settings (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  session_epoch  integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.auth_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- auth_login_attempts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_login_attempts (
  id            bigserial PRIMARY KEY,
  account_id    text NOT NULL,
  ip            text NOT NULL,
  success       boolean NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_login_attempts_account_idx
  ON public.auth_login_attempts (account_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_idx
  ON public.auth_login_attempts (ip, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- display_credentials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.display_credentials (
  display_uuid         uuid PRIMARY KEY REFERENCES public.event_displays (id) ON DELETE CASCADE,
  pairing_code_hash    text,
  pairing_expires_at   timestamptz,
  device_token_hash    text,
  paired_at            timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS display_credentials_device_token_idx
  ON public.display_credentials (device_token_hash);

-- ---------------------------------------------------------------------------
-- event_alerts: who sent it
-- ---------------------------------------------------------------------------
ALTER TABLE public.event_alerts ADD COLUMN IF NOT EXISTS created_by text;

-- ---------------------------------------------------------------------------
-- Retire the shared admin PIN
-- ---------------------------------------------------------------------------
ALTER TABLE public.event_control_state DROP COLUMN IF EXISTS pin_hash;

-- ---------------------------------------------------------------------------
-- Lock down the server-only tables
-- RLS on with no policies denies anon/authenticated; the service role bypasses
-- RLS. Privileges are revoked as well so a future permissive policy can't
-- silently re-expose them.
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_login_attempts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.display_credentials  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.accounts            FROM anon, authenticated;
REVOKE ALL ON public.auth_settings       FROM anon, authenticated;
REVOKE ALL ON public.auth_login_attempts FROM anon, authenticated;
REVOKE ALL ON public.display_credentials FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.auth_login_attempts_id_seq FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Existing tables: keep read access for displays, remove every write path
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "shared_event_state_insert" ON public.event_control_state;
DROP POLICY IF EXISTS "shared_event_state_update" ON public.event_control_state;
DROP POLICY IF EXISTS "shared_event_state_delete" ON public.event_control_state;

DROP POLICY IF EXISTS "shared_alerts_insert" ON public.event_alerts;
DROP POLICY IF EXISTS "shared_alerts_update" ON public.event_alerts;
DROP POLICY IF EXISTS "shared_alerts_delete" ON public.event_alerts;

DROP POLICY IF EXISTS "shared_displays_insert" ON public.event_displays;
DROP POLICY IF EXISTS "shared_displays_update" ON public.event_displays;
DROP POLICY IF EXISTS "shared_displays_delete" ON public.event_displays;

DROP POLICY IF EXISTS "shared_batches_insert" ON public.event_batches;
DROP POLICY IF EXISTS "shared_batches_update" ON public.event_batches;
DROP POLICY IF EXISTS "shared_batches_delete" ON public.event_batches;

DROP POLICY IF EXISTS "shared_logs_insert" ON public.event_audit_logs;
DROP POLICY IF EXISTS "shared_logs_update" ON public.event_audit_logs;
DROP POLICY IF EXISTS "shared_logs_delete" ON public.event_audit_logs;
-- The audit trail is staff-only now; the console reads it through the API.
DROP POLICY IF EXISTS "shared_logs_select" ON public.event_audit_logs;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.event_control_state FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.event_alerts        FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.event_displays      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.event_batches       FROM anon, authenticated;
REVOKE ALL                              ON public.event_audit_logs    FROM anon, authenticated;
