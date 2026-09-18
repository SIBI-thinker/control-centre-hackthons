import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { accountLabel, ISSUE_STATUSES, issueScopeFor, loadVisibleIssue } from '@/lib/server/issues';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * Moves an issue through open → acknowledged → resolved (or reopens it).
 * Staff only; operators only within their rooms.
 */
export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin', 'operator']);
  const id = parseUuid(params.id, 'issue id');
  const body = await readJson<{ status: string }>(req);
  const status = String(body.status ?? '');
  if ((ISSUE_STATUSES as readonly string[]).indexOf(status) === -1) throw new HttpError(400, 'Invalid status.');

  const scope = await issueScopeFor(account);
  const issue = await loadVisibleIssue(scope, id);
  if (issue.status === status) return json({ ok: true, unchanged: true });

  const nowIso = new Date().toISOString();
  const who = accountLabel(account);
  const updates: Record<string, string | null> = { status, updated_at: nowIso };

  if (status === 'acknowledged') {
    updates.acknowledged_by = who;
    updates.acknowledged_at = nowIso;
    updates.resolved_by = null;
    updates.resolved_at = null;
  } else if (status === 'resolved') {
    if (!issue.acknowledged_at) {
      updates.acknowledged_by = who;
      updates.acknowledged_at = nowIso;
    }
    updates.resolved_by = who;
    updates.resolved_at = nowIso;
  } else {
    // Reopened.
    updates.resolved_by = null;
    updates.resolved_at = null;
  }

  // Conditional on the status we read, so two responders clicking at once
  // can't silently overwrite each other.
  const { data, error } = await getServiceClient()
    .from('issues')
    .update(updates)
    .eq('id', id)
    .eq('status', issue.status)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(409, 'Someone else just updated this issue. Refresh to see the latest.');

  await audit(account.account_id, 'ISSUE_' + status.toUpperCase(), issue.title, issue.status + ' → ' + status);
  return json({ ok: true });
});
