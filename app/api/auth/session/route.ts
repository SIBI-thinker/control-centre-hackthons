import { NextRequest } from 'next/server';
import { handle, json } from '@/lib/server/http';
import { requireSession } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

/**
 * Who is signed in and when the session ends. The cookie is httpOnly, so this
 * is how the UI learns the expiry to show its countdown — and a revoked
 * session answers 401 here immediately.
 */
export const GET = handle(async (req: NextRequest) => {
  const { session } = await requireSession(req, ['admin', 'operator', 'participant']);
  return json({
    accountId: session.aid,
    name: session.name,
    role: session.role,
    expiresAt: session.exp * 1000,
    // Lets the browser correct for its own clock being wrong.
    serverNow: Date.now(),
  });
});
