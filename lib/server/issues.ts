import 'server-only';
import type { Account } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';

export const ISSUE_CATEGORIES = ['technical', 'wifi', 'power', 'food', 'medical', 'other'] as const;
export const ISSUE_PRIORITIES = ['low', 'normal', 'urgent'] as const;
export const ISSUE_STATUSES = ['open', 'acknowledged', 'resolved'] as const;

/**
 * What an account may see of the issue list. This is the single place issue
 * visibility is decided, so every issue route scopes through it.
 *   admin        everything
 *   operator     issues in rooms they're assigned to
 *   participant  issues raised for their own team
 */
export type IssueScope =
  | { kind: 'all' }
  | { kind: 'rooms'; roomIds: string[] }
  | { kind: 'team'; teamId: string; roomId: string | null };

export async function issueScopeFor(account: Account): Promise<IssueScope> {
  const db = getServiceClient();
  if (account.role === 'admin') return { kind: 'all' };

  if (account.role === 'operator') {
    const { data, error } = await db.from('operator_rooms').select('room_id').eq('account_id', account.id);
    if (error) throw error;
    return { kind: 'rooms', roomIds: (data ?? []).map((r) => r.room_id) };
  }

  const { data: me, error } = await db.from('accounts').select('team_id').eq('id', account.id).maybeSingle();
  if (error) throw error;
  if (!me?.team_id) throw new HttpError(403, 'Your account is not assigned to a team.');
  const { data: team, error: teamError } = await db.from('teams').select('room_id').eq('id', me.team_id).maybeSingle();
  if (teamError) throw teamError;
  return { kind: 'team', teamId: me.team_id, roomId: team?.room_id ?? null };
}

export function canSeeIssue(scope: IssueScope, issue: { room_id: string | null; team_id: string | null }): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'rooms') return Boolean(issue.room_id) && scope.roomIds.indexOf(issue.room_id as string) !== -1;
  return issue.team_id === scope.teamId;
}

/** Loads one issue and enforces that the caller may see it (404, not 403, so ids don't leak). */
export async function loadVisibleIssue(scope: IssueScope, issueId: string) {
  const { data, error } = await getServiceClient().from('issues').select('*').eq('id', issueId).maybeSingle();
  if (error) throw error;
  if (!data || !canSeeIssue(scope, data)) throw new HttpError(404, 'Issue not found.');
  return data;
}

export function accountLabel(account: Account): string {
  return account.account_id + ' · ' + account.display_name;
}

/** Everyone who should hear about an issue in a room: active admins + that room's operators. */
export async function responderAccounts(roomId: string | null, excludeAccountId?: string) {
  const db = getServiceClient();
  const [admins, operatorLinks] = await Promise.all([
    db.from('accounts').select('id, role').eq('role', 'admin').eq('active', true),
    roomId ? db.from('operator_rooms').select('account_id').eq('room_id', roomId) : Promise.resolve({ data: [], error: null }),
  ]);
  if (admins.error) throw admins.error;
  if (operatorLinks.error) throw operatorLinks.error;

  const recipients: { id: string; role: string }[] = (admins.data ?? []).slice();
  const operatorIds = (operatorLinks.data ?? []).map((l: { account_id: string }) => l.account_id);
  if (operatorIds.length > 0) {
    const { data: operators, error } = await db.from('accounts').select('id, role').in('id', operatorIds).eq('active', true);
    if (error) throw error;
    recipients.push(...(operators ?? []));
  }
  return recipients.filter((r) => r.id !== excludeAccountId);
}
