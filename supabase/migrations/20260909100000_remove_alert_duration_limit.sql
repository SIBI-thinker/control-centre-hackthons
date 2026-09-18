/*
# Remove the upper bound on alert duration

## Problem
`event_alerts.duration_seconds` was created with `CHECK (duration_seconds
BETWEEN 1 AND 600)`, capping any broadcast at 10 minutes. That makes it
impossible to post a notice that should stay up for the length of a real
break — a lunch break, a workshop slot, an overnight quiet period.

## Change
Drop the bounded check and replace it with a lower bound only, so a broadcast
can run for 15 minutes, an hour, three hours, or longer.

## Notes
- Alert duration is independent of the event timer: a long-running notice does
  not touch `event_control_state.duration_seconds` or `remaining_seconds`, and
  the hackathon clock keeps counting down underneath it.
- Still guards against zero/negative durations, which would expire instantly.
*/

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.event_alerts'::regclass
      AND conname = 'event_alerts_duration_seconds_check'
  ) THEN
    ALTER TABLE public.event_alerts
      DROP CONSTRAINT event_alerts_duration_seconds_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.event_alerts'::regclass
      AND conname = 'event_alerts_duration_positive'
  ) THEN
    ALTER TABLE public.event_alerts
      ADD CONSTRAINT event_alerts_duration_positive CHECK (duration_seconds >= 1);
  END IF;
END $$;
