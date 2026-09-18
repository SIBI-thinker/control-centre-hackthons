import { NextRequest, NextResponse } from 'next/server';
import { getSessionSecret, ROLE_HOME, SESSION_COOKIE, verifySession, type Role } from '@/lib/session';

/**
 * Page gating. Checks the session signature, hard expiry, and role.
 *
 * Revocation (a changed PIN, "end all sessions") needs the database, which the
 * Edge runtime doesn't reach — so a revoked session can still load a page
 * shell, but every API call it makes is refused with 401 and the page sends
 * the person back to sign in. No data or action is reachable either way.
 */

const PAGE_ROLES: Array<{ prefix: string; roles: Role[] }> = [
  { prefix: '/operator', roles: ['operator'] },
  { prefix: '/participant', roles: ['participant'] },
];

function rolesFor(pathname: string): Role[] {
  if (pathname === '/') return ['admin'];
  for (const rule of PAGE_ROLES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + '/')) return rule.roles;
  }
  return [];
}

export async function middleware(req: NextRequest) {
  const allowed = rolesFor(req.nextUrl.pathname);
  if (allowed.length === 0) return NextResponse.next();

  const toLogin = (reason?: string) => {
    const url = new URL('/login', req.url);
    if (reason) url.searchParams.set('reason', reason);
    return NextResponse.redirect(url);
  };

  const secret = getSessionSecret();
  if (!secret) return toLogin('misconfigured');

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return toLogin();

  const session = await verifySession(token, secret);
  if (!session) return toLogin('expired');

  // Signed in, but on another role's page — send them to their own.
  if (allowed.indexOf(session.role) === -1) {
    return NextResponse.redirect(new URL(ROLE_HOME[session.role], req.url));
  }

  return NextResponse.next();
}

export const config = { matcher: ['/', '/operator/:path*', '/participant/:path*'] };
