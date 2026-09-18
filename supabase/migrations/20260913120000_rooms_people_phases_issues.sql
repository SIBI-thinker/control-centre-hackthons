/*
# Rooms, people, phases, checklists, issues, push notifications

Schema for stages 2–6 in one migration, so it only needs applying once.

## Tables (all server-only: RLS on, no policies, privileges revoked)
- rooms                    physical rooms; displays, teams and operators belong to them
- teams                    a team sits in one room
- operator_rooms           which rooms each operator may manage
- phases                   scheduled event phases with requirement text
- phase_rooms              which rooms a phase applies to
- phase_checklist_items    checklist per phase
- team_checklist_progress  which items each team has ticked
- issues                   problems raised by participants or operators
- issue_messages           replies on an issue
- push_subscriptions       browser push endpoints for staff devices

## Changed
- accounts.team_id         a participant's team (required for participants)
- event_displays.room_id   the room a display is in

## Guarantees enforced by the database
- A participant always has a team; staff never do.
- Two phases can never overlap in the same room. Checked in a trigger under a
  per-room advisory lock, so concurrent saves can't race past each other.
- save_phase() writes a phase, its rooms and its checklist atomically, and
  keeps existing checklist item ids so teams don't lose ticks on an edit.
*/

-- ===========================================================================
-- ROOMS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9 ._-]{0,39}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  location    text CHECK (location IS NULL OR char_length(location) <= 120),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_code_key ON public.rooms (upper(code));

ALTER TABLE public.event_displays
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.rooms (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS event_displays_room_idx ON public.event_displays (room_id);

-- ===========================================================================
-- TEAMS & PEOPLE
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{0,39}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  room_id     uuid REFERENCES public.rooms (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_code_key ON public.teams (upper(code));
-- CSV imports group people by team name, so names must be unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_key ON public.teams (lower(name));
CREATE INDEX IF NOT EXISTS teams_room_idx ON public.teams (room_id);

-- RESTRICT: a team with participants can't be deleted out from under them.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS accounts_team_idx ON public.accounts (team_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_team_matches_role') THEN
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_team_matches_role
      CHECK ((role = 'participant') = (team_id IS NOT NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.operator_rooms (
  account_id  uuid NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  room_id     uuid NOT NULL REFERENCES public.rooms (id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, room_id)
);
CREATE INDEX IF NOT EXISTS operator_rooms_room_idx ON public.operator_rooms (room_id);

-- ===========================================================================
-- PHASES & CHECKLISTS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.phases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  requirements  text NOT NULL DEFAULT '' CHECK (char_length(requirements) <= 5000),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phases_window_valid CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS phases_window_idx ON public.phases (starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.phase_rooms (
  phase_id  uuid NOT NULL REFERENCES public.phases (id) ON DELETE CASCADE,
  room_id   uuid NOT NULL REFERENCES public.rooms (id) ON DELETE CASCADE,
  PRIMARY KEY (phase_id, room_id)
);
CREATE INDEX IF NOT EXISTS phase_rooms_room_idx ON public.phase_rooms (room_id);

CREATE TABLE IF NOT EXISTS public.phase_checklist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id    uuid NOT NULL REFERENCES public.phases (id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phase_checklist_items_phase_idx ON public.phase_checklist_items (phase_id, position);

CREATE TABLE IF NOT EXISTS public.team_checklist_progress (
  team_id     uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES public.phase_checklist_items (id) ON DELETE CASCADE,
  checked_by  text,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, item_id)
);
CREATE INDEX IF NOT EXISTS team_checklist_progress_item_idx ON public.team_checklist_progress (item_id);

-- ---------------------------------------------------------------------------
-- No two phases may overlap in the same room.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_room_has_no_phase_overlap(p_room_id uuid, p_phase_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_clash record;
BEGIN
  -- Serialises concurrent saves touching the same room.
  PERFORM pg_advisory_xact_lock(hashtext('phase_room:' || p_room_id::text));

  SELECT r.code AS room_code, other.title AS other_title
    INTO v_clash
    FROM public.phases me
    JOIN public.phase_rooms pr ON pr.room_id = p_room_id AND pr.phase_id <> me.id
    JOIN public.phases other   ON other.id = pr.phase_id
    JOIN public.rooms r        ON r.id = p_room_id
   WHERE me.id = p_phase_id
     AND tstzrange(me.starts_at, me.ends_at, '[)') && tstzrange(other.starts_at, other.ends_at, '[)')
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'PHASE_OVERLAP|%|%', v_clash.room_code, v_clash.other_title
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_phase_rooms_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_room_has_no_phase_overlap(NEW.room_id, NEW.phase_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_phases_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_room uuid;
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    FOR v_room IN SELECT room_id FROM public.phase_rooms WHERE phase_id = NEW.id LOOP
      PERFORM public.assert_room_has_no_phase_overlap(v_room, NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phase_rooms_no_overlap ON public.phase_rooms;
CREATE TRIGGER phase_rooms_no_overlap
  AFTER INSERT OR UPDATE ON public.phase_rooms
  FOR EACH ROW EXECUTE FUNCTION public.trg_phase_rooms_no_overlap();

DROP TRIGGER IF EXISTS phases_no_overlap ON public.phases;
CREATE TRIGGER phases_no_overlap
  AFTER UPDATE ON public.phases
  FOR EACH ROW EXECUTE FUNCTION public.trg_phases_no_overlap();

-- ---------------------------------------------------------------------------
-- save_phase: phase + rooms + checklist in one transaction.
--   p_items: [{ "id": "<uuid or null>", "label": "..." }, ...] in display order.
--   Items with an existing id keep that id (and every team's tick on it).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_phase(
  p_id            uuid,
  p_title         text,
  p_requirements  text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_room_ids      uuid[],
  p_items         jsonb,
  p_actor         text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id        uuid;
  v_item      jsonb;
  v_position  integer := 0;
  v_keep      uuid[] := ARRAY[]::uuid[];
  v_item_id   uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.phases (title, requirements, starts_at, ends_at, created_by)
    VALUES (p_title, coalesce(p_requirements, ''), p_starts_at, p_ends_at, p_actor)
    RETURNING id INTO v_id;
  ELSE
    -- Detach dropped rooms BEFORE moving the times. Otherwise the time-change
    -- trigger would still see a room being removed and report a false clash.
    DELETE FROM public.phase_rooms
     WHERE phase_id = p_id AND NOT (room_id = ANY (coalesce(p_room_ids, ARRAY[]::uuid[])));

    UPDATE public.phases
       SET title = p_title,
           requirements = coalesce(p_requirements, ''),
           starts_at = p_starts_at,
           ends_at = p_ends_at,
           updated_at = now()
     WHERE id = p_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'PHASE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Attach newly selected rooms. The insert trigger enforces no overlap.
  INSERT INTO public.phase_rooms (phase_id, room_id)
  SELECT v_id, rid FROM unnest(coalesce(p_room_ids, ARRAY[]::uuid[])) AS rid
  ON CONFLICT DO NOTHING;
  -- Existing rooms whose times just changed were checked by the phases trigger.

  -- Checklist: update kept items in place, insert new ones, drop the rest.
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    v_position := v_position + 1;
    v_item_id := NULLIF(v_item ->> 'id', '')::uuid;
    IF v_item_id IS NOT NULL THEN
      UPDATE public.phase_checklist_items
         SET label = v_item ->> 'label', position = v_position
       WHERE id = v_item_id AND phase_id = v_id;
      IF NOT FOUND THEN
        v_item_id := NULL;
      END IF;
    END IF;
    IF v_item_id IS NULL THEN
      INSERT INTO public.phase_checklist_items (phase_id, label, position)
      VALUES (v_id, v_item ->> 'label', v_position)
      RETURNING id INTO v_item_id;
    END IF;
    v_keep := v_keep || v_item_id;
  END LOOP;

  DELETE FROM public.phase_checklist_items WHERE phase_id = v_id AND NOT (id = ANY (v_keep));

  RETURN v_id;
END;
$$;

-- ===========================================================================
-- ISSUES
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           uuid REFERENCES public.rooms (id) ON DELETE SET NULL,
  team_id           uuid REFERENCES public.teams (id) ON DELETE SET NULL,
  raised_by         uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  raised_by_label   text NOT NULL,
  raised_by_role    text NOT NULL CHECK (raised_by_role IN ('admin', 'operator', 'participant')),
  category          text NOT NULL CHECK (category IN ('technical', 'wifi', 'power', 'food', 'medical', 'other')),
  priority          text NOT NULL CHECK (priority IN ('low', 'normal', 'urgent')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by   text,
  acknowledged_at   timestamptz,
  resolved_by       text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issues_status_idx ON public.issues (status, created_at DESC);
CREATE INDEX IF NOT EXISTS issues_room_idx ON public.issues (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS issues_team_idx ON public.issues (team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.issue_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id      uuid NOT NULL REFERENCES public.issues (id) ON DELETE CASCADE,
  author_id     uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  author_label  text NOT NULL,
  author_role   text NOT NULL CHECK (author_role IN ('admin', 'operator', 'participant')),
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_messages_issue_idx ON public.issue_messages (issue_id, created_at);

-- ===========================================================================
-- PUSH SUBSCRIPTIONS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  endpoint         text NOT NULL UNIQUE,
  p256dh           text NOT NULL,
  auth             text NOT NULL,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz
);
CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx ON public.push_subscriptions (account_id);

-- ===========================================================================
-- LOCKDOWN — every new table and function is server-only
-- ===========================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rooms', 'teams', 'operator_rooms', 'phases', 'phase_rooms', 'phase_checklist_items',
    'team_checklist_progress', 'issues', 'issue_messages', 'push_subscriptions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.save_phase(uuid, text, text, timestamptz, timestamptz, uuid[], jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_room_has_no_phase_overlap(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_phase(uuid, text, text, timestamptz, timestamptz, uuid[], jsonb, text) TO service_role;

-- Make the API layer pick up the new tables and save_phase() immediately.
NOTIFY pgrst, 'reload schema';
