/*
# Add admin PIN, batches, and seed data

1. New Tables
- `event_batches`: batch/group names for targeted messaging (CSE-A, ECE-B, etc.)

2. Modified Tables
- `event_control_state`: add `pin_hash`, `sound_enabled`, `heartbeat_interval`, `offline_timeout` columns

3. Seed Data
- Default admin PIN hash (SHA-256 of "yhack26:123456")
- Default batches (CSE-A, CSE-B, ECE-A, ECE-B, EEE, MECH, IT)
- Default displays (DISPLAY-01 Main Auditorium ALL, DISPLAY-02 CSE Lab CSE, DISPLAY-03 ECE Lab ECE)
- Default audit log entries

4. Security
- RLS enabled on event_batches with anon+authenticated CRUD
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.event_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.event_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shared_batches_select" ON public.event_batches;
CREATE POLICY "shared_batches_select" ON public.event_batches FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_batches_insert" ON public.event_batches;
CREATE POLICY "shared_batches_insert" ON public.event_batches FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_batches_update" ON public.event_batches;
CREATE POLICY "shared_batches_update" ON public.event_batches FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_batches_delete" ON public.event_batches;
CREATE POLICY "shared_batches_delete" ON public.event_batches FOR DELETE TO anon, authenticated USING (true);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_control_state' AND column_name = 'pin_hash') THEN
    ALTER TABLE public.event_control_state ADD COLUMN pin_hash text;
    ALTER TABLE public.event_control_state ADD COLUMN sound_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE public.event_control_state ADD COLUMN heartbeat_interval integer NOT NULL DEFAULT 10;
    ALTER TABLE public.event_control_state ADD COLUMN offline_timeout integer NOT NULL DEFAULT 30;
  END IF;
END $$;

UPDATE public.event_control_state SET pin_hash = encode(digest('yhack26:123456', 'sha256'), 'hex') WHERE pin_hash IS NULL;

INSERT INTO public.event_batches (name) VALUES
  ('CSE-A'), ('CSE-B'), ('ECE-A'), ('ECE-B'), ('EEE'), ('MECH'), ('IT')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.event_displays (display_id, display_name, location, batch) VALUES
  ('DISPLAY-01', 'Main Auditorium', 'Main Hall', 'ALL'),
  ('DISPLAY-02', 'CSE Lab', 'CSE Lab', 'CSE'),
  ('DISPLAY-03', 'ECE Lab', 'ECE Lab', 'ECE')
ON CONFLICT (display_id) DO NOTHING;

INSERT INTO public.event_audit_logs (action, actor, target, details) VALUES
  ('SYSTEM_INIT', 'SYSTEM', 'ALL', 'Event control system initialized'),
  ('DISPLAY_REGISTERED', 'SYSTEM', 'DISPLAY-01', 'Main Auditorium registered'),
  ('DISPLAY_REGISTERED', 'SYSTEM', 'DISPLAY-02', 'CSE Lab registered'),
  ('DISPLAY_REGISTERED', 'SYSTEM', 'DISPLAY-03', 'ECE Lab registered')
ON CONFLICT DO NOTHING;
