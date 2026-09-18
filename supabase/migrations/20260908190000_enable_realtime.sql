/*
# Enable realtime delivery for the event control tables

## Problem
The tables were created with RLS policies but were never added to the
`supabase_realtime` publication. Clients could `.subscribe()` successfully and
receive a `SUBSCRIBED` status, but Postgres never published any row changes to
them — so no `postgres_changes` callback ever fired.

The visible symptom: an operator sends a broadcast from the control center, the
row is written correctly, and the venue displays never show it. They only pick
up state on a full page reload.

## Change
1. Add every event table to the `supabase_realtime` publication.
2. Set `REPLICA IDENTITY FULL` so UPDATE and DELETE payloads carry the complete
   row (needed for the old-record comparisons and for RLS checks on updates).

## Notes
- `event_control_state` is the alert/timer transport and is the critical one.
- `event_displays` carries heartbeats, so without it the console shows every
  node as offline until refreshed.
- Safe to re-run: publication membership is guarded by a catalog lookup.
*/

ALTER TABLE public.event_control_state REPLICA IDENTITY FULL;
ALTER TABLE public.event_alerts        REPLICA IDENTITY FULL;
ALTER TABLE public.event_displays      REPLICA IDENTITY FULL;
ALTER TABLE public.event_batches       REPLICA IDENTITY FULL;
ALTER TABLE public.event_audit_logs    REPLICA IDENTITY FULL;

DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'event_control_state',
    'event_alerts',
    'event_displays',
    'event_batches',
    'event_audit_logs'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
