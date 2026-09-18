/*
# Phase forms, and the Wi-Fi network password

## Why
A phase needs to collect written work from each team — a handful of long
answers, plus which problem statement the team chose. One shared answer per
team, editable while the phase is running in their room and frozen when it
ends.

## Added
- wifi_settings.ssid_password  the network passphrase (joining the Wi-Fi),
  which is separate from the per-team login username/password already there.
- phase_fields          up to 10 questions on a phase, in order
- phase_field_options   the choices on a selector field; `body` holds the full
                        problem statement, which can be very long
- team_phase_answers    one row per team per field

## Kept stable on edit
phase_fields and phase_field_options keep their ids when a phase is edited, so
a team's answers survive an admin fixing a typo in the question. Deleting a
field does delete its answers — that is the point of deleting it.

## Locking
Not enforced by a constraint: "editable" depends on the clock, and a row-level
rule would need the phase window on every write. The API checks the phase is
running in the team's room before accepting a save, and the export reads
whatever was last saved.

## Safe to re-run.
*/

-- ---------------------------------------------------------------------------
-- Wi-Fi network password
-- ---------------------------------------------------------------------------
ALTER TABLE public.wifi_settings
  ADD COLUMN IF NOT EXISTS ssid_password text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wifi_settings_ssid_password_len'
  ) THEN
    ALTER TABLE public.wifi_settings
      ADD CONSTRAINT wifi_settings_ssid_password_len
      CHECK (ssid_password IS NULL OR char_length(ssid_password) <= 120);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase form
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phase_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id    uuid NOT NULL REFERENCES public.phases (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('text', 'choice')),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  help        text NOT NULL DEFAULT '' CHECK (char_length(help) <= 2000),
  required    boolean NOT NULL DEFAULT false,
  -- How much a team may write. Long by default: these are paragraphs.
  max_length  integer NOT NULL DEFAULT 5000 CHECK (max_length BETWEEN 1 AND 20000),
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phase_fields_phase_idx ON public.phase_fields (phase_id, position);

CREATE TABLE IF NOT EXISTS public.phase_field_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id    uuid NOT NULL REFERENCES public.phase_fields (id) ON DELETE CASCADE,
  -- A short title for lists and the CSV; `body` carries the full statement.
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  body        text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phase_field_options_field_idx ON public.phase_field_options (field_id, position);

CREATE TABLE IF NOT EXISTS public.team_phase_answers (
  team_id     uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
  field_id    uuid NOT NULL REFERENCES public.phase_fields (id) ON DELETE CASCADE,
  value       text NOT NULL DEFAULT '' CHECK (char_length(value) <= 20000),
  -- SET NULL, not CASCADE: removing an option must not silently delete the
  -- answer row and hide that the team had chosen something.
  option_id   uuid REFERENCES public.phase_field_options (id) ON DELETE SET NULL,
  answered_by text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, field_id)
);
CREATE INDEX IF NOT EXISTS team_phase_answers_field_idx ON public.team_phase_answers (field_id);

-- ---------------------------------------------------------------------------
-- At most 10 fields on a phase. Checked in a trigger because a CHECK cannot
-- count sibling rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_phase_fields_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.phase_fields WHERE phase_id = NEW.phase_id;
  IF v_count > 10 THEN
    RAISE EXCEPTION 'PHASE_FIELD_LIMIT' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS phase_fields_limit ON public.phase_fields;
CREATE TRIGGER phase_fields_limit
  AFTER INSERT ON public.phase_fields
  FOR EACH ROW EXECUTE FUNCTION public.trg_phase_fields_limit();

-- ---------------------------------------------------------------------------
-- Server-only, like every other staff table: RLS on with no policies denies
-- anon and authenticated; the service role bypasses it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.phase_fields         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase_field_options  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_phase_answers   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.phase_fields        FROM anon, authenticated;
REVOKE ALL ON public.phase_field_options FROM anon, authenticated;
REVOKE ALL ON public.team_phase_answers  FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- save_phase, now also writing the form.
--   p_fields: [{ id, kind, label, help, required, max_length,
--                options: [{ id, label, body }] }, ...] in display order.
--   Ids that still exist are kept, so answers survive an edit.
-- The old 7-argument version is dropped: two overloads would make the call
-- ambiguous over PostgREST.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_phase(uuid, text, text, timestamptz, timestamptz, uuid[], jsonb, text);

CREATE OR REPLACE FUNCTION public.save_phase(
  p_id            uuid,
  p_title         text,
  p_requirements  text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_room_ids      uuid[],
  p_items         jsonb,
  p_fields        jsonb,
  p_actor         text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id          uuid;
  v_item        jsonb;
  v_field       jsonb;
  v_option      jsonb;
  v_position    integer := 0;
  v_opt_pos     integer;
  v_keep        uuid[] := ARRAY[]::uuid[];
  v_keep_fields uuid[] := ARRAY[]::uuid[];
  v_keep_opts   uuid[] := ARRAY[]::uuid[];
  v_item_id     uuid;
  v_field_id    uuid;
  v_option_id   uuid;
BEGIN
  IF jsonb_array_length(coalesce(p_fields, '[]'::jsonb)) > 10 THEN
    RAISE EXCEPTION 'PHASE_FIELD_LIMIT' USING ERRCODE = 'check_violation';
  END IF;

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
    v_keep := array_append(v_keep, v_item_id);
  END LOOP;

  DELETE FROM public.phase_checklist_items
   WHERE phase_id = v_id AND NOT (id = ANY (v_keep));

  -- Form fields, the same way: kept ids keep their answers.
  v_position := 0;
  FOR v_field IN SELECT * FROM jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) LOOP
    v_position := v_position + 1;
    v_field_id := NULLIF(v_field ->> 'id', '')::uuid;
    IF v_field_id IS NOT NULL THEN
      UPDATE public.phase_fields
         SET kind = v_field ->> 'kind',
             label = v_field ->> 'label',
             help = coalesce(v_field ->> 'help', ''),
             required = coalesce((v_field ->> 'required')::boolean, false),
             max_length = coalesce((v_field ->> 'max_length')::integer, 5000),
             position = v_position
       WHERE id = v_field_id AND phase_id = v_id;
      IF NOT FOUND THEN
        v_field_id := NULL;
      END IF;
    END IF;
    IF v_field_id IS NULL THEN
      INSERT INTO public.phase_fields (phase_id, kind, label, help, required, max_length, position)
      VALUES (
        v_id,
        v_field ->> 'kind',
        v_field ->> 'label',
        coalesce(v_field ->> 'help', ''),
        coalesce((v_field ->> 'required')::boolean, false),
        coalesce((v_field ->> 'max_length')::integer, 5000),
        v_position
      )
      RETURNING id INTO v_field_id;
    END IF;
    v_keep_fields := array_append(v_keep_fields, v_field_id);

    v_opt_pos := 0;
    FOR v_option IN SELECT * FROM jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) LOOP
      v_opt_pos := v_opt_pos + 1;
      v_option_id := NULLIF(v_option ->> 'id', '')::uuid;
      IF v_option_id IS NOT NULL THEN
        UPDATE public.phase_field_options
           SET label = v_option ->> 'label',
               body = coalesce(v_option ->> 'body', ''),
               position = v_opt_pos
         WHERE id = v_option_id AND field_id = v_field_id;
        IF NOT FOUND THEN
          v_option_id := NULL;
        END IF;
      END IF;
      IF v_option_id IS NULL THEN
        INSERT INTO public.phase_field_options (field_id, label, body, position)
        VALUES (v_field_id, v_option ->> 'label', coalesce(v_option ->> 'body', ''), v_opt_pos)
        RETURNING id INTO v_option_id;
      END IF;
      v_keep_opts := array_append(v_keep_opts, v_option_id);
    END LOOP;
  END LOOP;

  DELETE FROM public.phase_field_options
   WHERE field_id = ANY (v_keep_fields) AND NOT (id = ANY (v_keep_opts));

  DELETE FROM public.phase_fields
   WHERE phase_id = v_id AND NOT (id = ANY (v_keep_fields));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_phase(uuid, text, text, timestamptz, timestamptz, uuid[], jsonb, jsonb, text) FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
