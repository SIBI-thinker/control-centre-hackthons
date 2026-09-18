/*
# Wi-Fi credentials for teams and participants

Participants need the venue's internet login on their own page.

## Model
The SSID is the same across the venue, so it lives once in `wifi_settings`
along with joining instructions and an optional default login.

`wifi_credentials` holds the pool of logins. Each row may be:
  - unassigned          (in the pool, waiting to be allotted)
  - assigned to a team  (every member of that team sees it)
  - assigned to one participant

A participant sees, in order: their personal login, else their team's login,
else the event-wide default, else nothing. That covers both ways a college
might hand these out, without a schema change if it turns out to be the other.

## Note on storage
These are stored readable, not hashed — they have to be displayed. Anyone with
database access can read them. Both tables are server-only (RLS on, no
policies, privileges revoked), so the public anon key cannot.
*/

CREATE TABLE IF NOT EXISTS public.wifi_settings (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  ssid          text CHECK (ssid IS NULL OR char_length(ssid) <= 64),
  instructions  text CHECK (instructions IS NULL OR char_length(instructions) <= 1000),
  -- Fallback login for anyone without a personal or team one.
  default_username text CHECK (default_username IS NULL OR char_length(default_username) <= 120),
  default_password text CHECK (default_password IS NULL OR char_length(default_password) <= 120),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.wifi_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.wifi_credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL CHECK (char_length(username) BETWEEN 1 AND 120),
  password            text NOT NULL CHECK (char_length(password) BETWEEN 1 AND 120),
  label               text CHECK (label IS NULL OR char_length(label) <= 120),
  assigned_team_id    uuid REFERENCES public.teams (id) ON DELETE SET NULL,
  assigned_account_id uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- A login belongs to a team or to one person, never both.
  CONSTRAINT wifi_single_owner CHECK (assigned_team_id IS NULL OR assigned_account_id IS NULL)
);

-- The same login must not be handed to two teams (or two people).
CREATE UNIQUE INDEX IF NOT EXISTS wifi_credentials_team_key
  ON public.wifi_credentials (assigned_team_id) WHERE assigned_team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wifi_credentials_account_key
  ON public.wifi_credentials (assigned_account_id) WHERE assigned_account_id IS NOT NULL;
-- Catches the same username being imported twice.
CREATE UNIQUE INDEX IF NOT EXISTS wifi_credentials_username_key
  ON public.wifi_credentials (lower(username));

ALTER TABLE public.wifi_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wifi_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wifi_settings FROM anon, authenticated;
REVOKE ALL ON public.wifi_credentials FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
