/*
# Create YHACK'26 event control state

1. New Tables
- `event_control_state`: the single shared timer, event status, active alert, and branding state.
- `event_alerts`: immediate and scheduled alert records with targeting and execution state.
- `event_displays`: registered venue screens with location, batch, and heartbeat status.
- `event_audit_logs`: immutable-style operational history for timer and alert actions.

2. Security
- Row-level security is enabled on every table.
- This is an intentionally single-tenant venue control system. The anon and authenticated client roles can operate the shared event state through the application.

3. Important Notes
- Timer timestamps are stored as UTC timestamptz values so displays can calculate remaining time consistently.
- Scheduled alerts include an execution status to support idempotent server-side scheduling later.
*/

CREATE TABLE IF NOT EXISTS public.event_control_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name text NOT NULL DEFAULT 'YHACK''26',
  organization text NOT NULL DEFAULT 'IEEE Robotics and Automation Society',
  timer_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (timer_status IN ('NOT_STARTED', 'RUNNING', 'PAUSED', 'ENDED')),
  duration_seconds integer NOT NULL DEFAULT 86400 CHECK (duration_seconds >= 0),
  remaining_seconds integer NOT NULL DEFAULT 86400 CHECK (remaining_seconds >= 0),
  started_at timestamptz,
  paused_at timestamptz,
  ends_at timestamptz,
  active_alert jsonb,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  message_type text NOT NULL DEFAULT 'INFO' CHECK (message_type IN ('INFO', 'WARNING', 'ALERT', 'SUCCESS', 'URGENT', 'ANNOUNCEMENT')),
  animation text NOT NULL DEFAULT 'GLITCH',
  duration_seconds integer NOT NULL DEFAULT 15 CHECK (duration_seconds BETWEEN 1 AND 600),
  target text NOT NULL DEFAULT 'ALL DISPLAYS',
  scheduled_for timestamptz,
  execution_status text NOT NULL DEFAULT 'PENDING' CHECK (execution_status IN ('PENDING', 'EXECUTED', 'CANCELLED', 'FAILED')),
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_displays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id text UNIQUE NOT NULL,
  display_name text NOT NULL,
  location text NOT NULL,
  batch text NOT NULL DEFAULT 'ALL',
  enabled boolean NOT NULL DEFAULT true,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor text NOT NULL DEFAULT 'ADMIN',
  target text,
  details text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.event_control_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_displays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_audit_logs ENABLE ROW LEVEL SECURITY;

INSERT INTO public.event_control_state (event_name)
SELECT 'YHACK''26'
WHERE NOT EXISTS (SELECT 1 FROM public.event_control_state);

DROP POLICY IF EXISTS "shared_event_state_select" ON public.event_control_state;
CREATE POLICY "shared_event_state_select" ON public.event_control_state FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_event_state_insert" ON public.event_control_state;
CREATE POLICY "shared_event_state_insert" ON public.event_control_state FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_event_state_update" ON public.event_control_state;
CREATE POLICY "shared_event_state_update" ON public.event_control_state FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_event_state_delete" ON public.event_control_state;
CREATE POLICY "shared_event_state_delete" ON public.event_control_state FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shared_alerts_select" ON public.event_alerts;
CREATE POLICY "shared_alerts_select" ON public.event_alerts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_alerts_insert" ON public.event_alerts;
CREATE POLICY "shared_alerts_insert" ON public.event_alerts FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_alerts_update" ON public.event_alerts;
CREATE POLICY "shared_alerts_update" ON public.event_alerts FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_alerts_delete" ON public.event_alerts;
CREATE POLICY "shared_alerts_delete" ON public.event_alerts FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shared_displays_select" ON public.event_displays;
CREATE POLICY "shared_displays_select" ON public.event_displays FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_displays_insert" ON public.event_displays;
CREATE POLICY "shared_displays_insert" ON public.event_displays FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_displays_update" ON public.event_displays;
CREATE POLICY "shared_displays_update" ON public.event_displays FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_displays_delete" ON public.event_displays;
CREATE POLICY "shared_displays_delete" ON public.event_displays FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shared_logs_select" ON public.event_audit_logs;
CREATE POLICY "shared_logs_select" ON public.event_audit_logs FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_logs_insert" ON public.event_audit_logs;
CREATE POLICY "shared_logs_insert" ON public.event_audit_logs FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_logs_update" ON public.event_audit_logs;
CREATE POLICY "shared_logs_update" ON public.event_audit_logs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_logs_delete" ON public.event_audit_logs;
CREATE POLICY "shared_logs_delete" ON public.event_audit_logs FOR DELETE TO anon, authenticated USING (true);