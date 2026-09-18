import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json, readJson } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin', 'operator']);
  const body = await readJson<{ endpoint: string }>(req);
  if (typeof body.endpoint === 'string' && body.endpoint) {
    const { error } = await getServiceClient().from('push_subscriptions').delete().eq('endpoint', body.endpoint).eq('account_id', account.id);
    if (error) throw error;
  }
  return json({ ok: true });
});
