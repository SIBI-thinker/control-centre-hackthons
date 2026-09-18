import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { handle, json } from '@/lib/server/http';
import { pushConfigured } from '@/lib/server/push';

export const dynamic = 'force-dynamic';

/** The VAPID public key browsers need to subscribe. Staff only. */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin', 'operator']);
  if (!pushConfigured()) return json({ publicKey: null });
  return json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});
