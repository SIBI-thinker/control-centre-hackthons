import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { pushConfigured, pushToAccounts } from '@/lib/server/push';

export const dynamic = 'force-dynamic';

/**
 * Registers this browser for issue notifications. An endpoint belongs to one
 * device; if someone else signs in on it, it moves to their account.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin', 'operator']);
  if (!pushConfigured()) throw new HttpError(503, 'Push notifications are not configured on the server.');

  const body = await readJson<{ endpoint: string; keys: { p256dh: string; auth: string }; test?: boolean }>(req);
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const keys = (body.keys ?? {}) as { p256dh?: string; auth?: string };

  // Only accept real push-service URLs, never an arbitrary server we'd then POST to.
  let host = '';
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error();
    host = url.hostname;
  } catch {
    throw new HttpError(400, 'Invalid push subscription.');
  }
  const knownPushHosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
  if (!knownPushHosts.some((h) => host === h || host.endsWith('.' + h))) {
    throw new HttpError(400, 'Unsupported push service.');
  }
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw new HttpError(400, 'Invalid push subscription.');
  }

  const { error } = await getServiceClient()
    .from('push_subscriptions')
    .upsert(
      {
        account_id: account.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: (req.headers.get('user-agent') || '').slice(0, 300),
      },
      { onConflict: 'endpoint' }
    );
  if (error) throw error;

  if (body.test) {
    await pushToAccounts([{ id: account.id, role: account.role }], () => ({
      title: 'Notifications are on',
      body: 'This device will be alerted when issues are raised' + (account.role === 'operator' ? ' in your rooms.' : '.'),
      url: account.role === 'operator' ? '/operator' : '/',
      tag: 'push-test',
    }));
  }

  return json({ ok: true });
});
