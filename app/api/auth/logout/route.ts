import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookies } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ success: true });
  clearSessionCookies(res);
  return res;
}
