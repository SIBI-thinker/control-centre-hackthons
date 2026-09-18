import { NextRequest, NextResponse } from 'next/server';
import { DISPLAY_COOKIE } from '@/lib/server/display';

export const dynamic = 'force-dynamic';

/**
 * Forgets the pairing on this kiosk only. The server-side token stays valid
 * until an admin issues a new pairing code for the display, which revokes it.
 */
export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(DISPLAY_COOKIE);
  return res;
}
