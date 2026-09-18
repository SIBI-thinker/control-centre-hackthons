/*
  # Allow two teams to share a name

  ## Why
  Two different rooms can legitimately run a team called "Team 5", and forcing
  the second one to be renamed made the roster disagree with the room.

  ## Changed
  - teams_name_key (UNIQUE on lower(name)) is dropped and replaced by a plain
    index, which still makes name lookups fast.
  - teams.code stays UNIQUE. It is now the only way to point at one specific
    team, which is what CSV imports fall back to when a name matches more than
    one team.

  ## Safe to re-run.
*/

DROP INDEX IF EXISTS public.teams_name_key;
CREATE INDEX IF NOT EXISTS teams_name_idx ON public.teams (lower(name));

NOTIFY pgrst, 'reload schema';
