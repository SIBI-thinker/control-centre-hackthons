import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { accountLabel, issueScopeFor, loadVisibleIssue, responderAccounts } from '@/lib/server/issues';
import { pushToAccounts } from '@/lib/server/push';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * Adds a reply. Staff replies are what the raising team sees as status
 * updates; a participant's follow-up notifies the responders.
 */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin', 'operator', 'participant']);
  const id = parseUuid(params.id, 'issue id');
  const body = await readJson<{ body: string }>(req);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) throw new HttpError(400, 'Write a message.');
  if (text.length > 1000) throw new HttpError(400, 'Messages must be at most 1000 characters.');

  const scope = await issueScopeFor(account);
  const issue = await loadVisibleIssue(scope, id);
  if (account.role === 'participant' && issue.status === 'resolved') {
    throw new HttpError(409, 'This issue is resolved. Raise a new one if the problem is back.');
  }

  const db = getServiceClient();
  const { data: message, error } = await db
    .from('issue_messages')
    .insert({ issue_id: id, author_id: account.id, author_label: accountLabel(account), author_role: account.role, body: text })
    .select('id, issue_id, author_label, author_role, body, created_at')
    .single();
  if (error) throw error;

  await db.from('issues').update({ updated_at: new Date().toISOString() }).eq('id', id);

  if (account.role === 'participant') {
    const recipients = await responderAccounts(issue.room_id, account.id);
    await pushToAccounts(recipients, (role) => ({
      title: 'Update on: ' + issue.title,
      body: text.slice(0, 160),
      url: role === 'operator' ? '/operator' : '/?view=issues',
      tag: 'issue-' + issue.id,
    }));
  }

  return json({ message });
});
