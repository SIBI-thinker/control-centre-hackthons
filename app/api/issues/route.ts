import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import {
  accountLabel,
  ISSUE_CATEGORIES,
  ISSUE_PRIORITIES,
  issueScopeFor,
  responderAccounts,
} from '@/lib/server/issues';
import { pushToAccounts } from '@/lib/server/push';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/**
 * Issues visible to the caller, newest first, with their reply threads.
 * Unresolved issues are always included; resolved ones are capped so the list
 * stays fast late in a long event.
 */
export const GET = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin', 'operator', 'participant']);
  const scope = await issueScopeFor(account);
  const db = getServiceClient();

  const scoped = (query: any) => {
    if (scope.kind === 'rooms') return scope.roomIds.length ? query.in('room_id', scope.roomIds) : null;
    if (scope.kind === 'team') return query.eq('team_id', scope.teamId);
    return query;
  };

  const openQuery = scoped(db.from('issues').select('*').neq('status', 'resolved').order('created_at', { ascending: false }).limit(500));
  const resolvedQuery = scoped(db.from('issues').select('*').eq('status', 'resolved').order('resolved_at', { ascending: false }).limit(100));
  if (!openQuery || !resolvedQuery) return json({ issues: [], serverNow: Date.now() });

  const [open, resolved] = await Promise.all([openQuery, resolvedQuery]);
  if (open.error) throw open.error;
  if (resolved.error) throw resolved.error;

  const issues = (open.data ?? []).concat(resolved.data ?? []);
  let messages: any[] = [];
  if (issues.length > 0) {
    const { data, error } = await db
      .from('issue_messages')
      .select('id, issue_id, author_label, author_role, body, created_at')
      .in('issue_id', issues.map((i: { id: string }) => i.id))
      .order('created_at');
    if (error) throw error;
    messages = data ?? [];
  }

  // Room and team labels, so every view can show "F101 · Byte Me".
  const roomIds = Array.from(new Set(issues.map((i: any) => i.room_id).filter(Boolean)));
  const teamIds = Array.from(new Set(issues.map((i: any) => i.team_id).filter(Boolean)));
  const [rooms, teams] = await Promise.all([
    roomIds.length ? db.from('rooms').select('id, code').in('id', roomIds) : Promise.resolve({ data: [], error: null }),
    teamIds.length ? db.from('teams').select('id, name').in('id', teamIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const roomCode: Record<string, string> = {};
  const teamName: Record<string, string> = {};
  (rooms.data ?? []).forEach((r: any) => (roomCode[r.id] = r.code));
  (teams.data ?? []).forEach((t: any) => (teamName[t.id] = t.name));

  return json({
    serverNow: Date.now(),
    issues: issues.map((issue: any) => ({
      ...issue,
      room_code: issue.room_id ? roomCode[issue.room_id] ?? null : null,
      team_name: issue.team_id ? teamName[issue.team_id] ?? null : null,
      // Participants see who on staff replied by role, not by personal ID.
      raised_by_label: account.role === 'participant' && issue.raised_by_role !== 'participant' ? 'Event staff' : issue.raised_by_label,
      messages: messages
        .filter((m) => m.issue_id === issue.id)
        .map((m) => ({
          ...m,
          author_label: account.role === 'participant' && m.author_role !== 'participant' ? 'Event staff' : m.author_label,
        })),
    })),
  });
});

const PARTICIPANT_LIMIT = { count: 5, minutes: 10 };

const CATEGORY_LABEL: Record<string, string> = {
  technical: 'Technical',
  wifi: 'Wi-Fi',
  power: 'Power',
  food: 'Food',
  medical: 'Medical',
  other: 'Other',
};

/**
 * Raises an issue. A participant's room and team come from their account,
 * never from the request. Operators may only raise issues for their own rooms.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin', 'operator', 'participant']);
  const body = await readJson<Record<string, unknown>>(req);
  const db = getServiceClient();
  const scope = await issueScopeFor(account);

  const category = String(body.category ?? '');
  const priority = String(body.priority ?? 'normal');
  if ((ISSUE_CATEGORIES as readonly string[]).indexOf(category) === -1) throw new HttpError(400, 'Choose a category.');
  if ((ISSUE_PRIORITIES as readonly string[]).indexOf(priority) === -1) throw new HttpError(400, 'Choose a priority.');
  const title = requireString(body.title, 'Title', 120);
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : '';

  let roomId: string | null = null;
  let teamId: string | null = null;

  if (scope.kind === 'team') {
    teamId = scope.teamId;
    roomId = scope.roomId;

    // Stop a single participant flooding the core team.
    const since = new Date(Date.now() - PARTICIPANT_LIMIT.minutes * 60 * 1000).toISOString();
    const { data: recent, error } = await db.from('issues').select('id').eq('raised_by', account.id).gte('created_at', since);
    if (error) throw error;
    if ((recent ?? []).length >= PARTICIPANT_LIMIT.count) {
      throw new HttpError(429, 'You have raised several issues in the last few minutes. A volunteer is on the way — add details to an existing issue instead.');
    }
  } else {
    roomId = body.room_id ? parseUuid(body.room_id, 'room') : null;
    if (scope.kind === 'rooms') {
      if (!roomId) throw new HttpError(400, 'Choose which of your rooms this is about.');
      if (scope.roomIds.indexOf(roomId) === -1) throw new HttpError(403, 'You can only raise issues for rooms you operate.');
    }
    if (body.team_id) {
      teamId = parseUuid(body.team_id, 'team');
      const { data: team, error } = await db.from('teams').select('room_id').eq('id', teamId).maybeSingle();
      if (error) throw error;
      if (!team) throw new HttpError(400, 'That team no longer exists.');
      if (scope.kind === 'rooms' && team.room_id !== roomId) throw new HttpError(400, 'That team is not in the selected room.');
    }
  }

  const { data: issue, error } = await db
    .from('issues')
    .insert({
      room_id: roomId,
      team_id: teamId,
      raised_by: account.id,
      raised_by_label: accountLabel(account),
      raised_by_role: account.role,
      category,
      priority,
      title,
      description,
    })
    .select('*')
    .single();
  if (error) throw error;

  let roomCode: string | null = null;
  if (roomId) {
    const { data: room } = await db.from('rooms').select('code').eq('id', roomId).maybeSingle();
    roomCode = room?.code ?? null;
  }

  await audit(account.account_id, 'ISSUE_RAISED', roomCode || 'NO ROOM', '[' + priority + '/' + category + '] ' + title);

  const recipients = await responderAccounts(roomId, account.id);
  await pushToAccounts(recipients, (role) => ({
    title: (priority === 'urgent' ? '🚨 URGENT · ' : '') + CATEGORY_LABEL[category] + (roomCode ? ' · ' + roomCode : ''),
    body: title + (description ? ' — ' + description.slice(0, 140) : ''),
    url: role === 'operator' ? '/operator' : '/?view=issues',
    tag: 'issue-' + issue.id,
    urgent: priority === 'urgent',
  }));

  return json({ issue });
});
