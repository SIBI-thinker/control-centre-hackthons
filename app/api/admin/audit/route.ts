import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Audit trail — staff only now that the anon key can no longer read it. */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const { data, error } = await getServiceClient()
    .from('event_audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return json({ logs: data ?? [] });
});
