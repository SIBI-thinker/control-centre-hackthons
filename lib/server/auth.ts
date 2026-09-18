import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/server/db';
import { cached, invalidate } from '@/lib/server/cache';
import { HttpError } from '@/lib/server/http';
import {
  getSessionSecret,
  RETIRED_SESSION_COOKIES,
  ROLE_SESSION_SECONDS,
  SESSION_COOKIE,
  signSession,
  verifySession,
  type Role,
  type SessionPayload,
} from '@/lib/session';

export type Account = {
  id: string;
  account_id: string;
  role: Role;
  display_name: string;
  active: boolean;
  session_version: number;
};

export type AuthedRequest = { session: SessionPayload; account: Account };

function requireSecret(): string {
  const secret = getSessionSecret();
  if (!secret) {
    throw new HttpError(503, 'Server is not configured: SESSION_SECRET is missing or shorter than 32 characters.');
  }
  return secret;
}

/**
 * Read on every authenticated request, and the same number for everyone.
 * Cached very briefly: "end all sessions" then takes effect within a few
 * seconds rather than instantly, which is invisible to a person but turns
 * thousands of identical reads a minute into a handful.
 */
const EPOCH_CACHE_MS = 5000;

export function invalidateSessionEpoch() {
  invalidate('auth:epoch');
}

export function getSessionEpoch(): Promise<number> {
  return cached('auth:epoch', EPOCH_CACHE_MS, async () => {
    const { data, error } = await getServiceClient().from('auth_settings').select('session_epoch').eq('id', true).maybeSingle();
    if (error) throw error;
    return data?.session_epoch ?? 1;
  });
}

/**
 * Authenticates a request for an API route.
 *
 * Beyond the signature and hard expiry (which middleware also checks), this
 * confirms against the database that the account still exists, is active, and
 * hasn't been revoked — individually (session_version) or globally
 * (session_epoch).
 *
 * Both of those reads are cached for a few seconds, so revocation takes effect
 * within seconds rather than on the very next call. That is the trade for
 * being able to serve a couple of thousand people from one laptop: without it,
 * every single API call is two extra database round trips.
 */
const ACCOUNT_CACHE_MS = 5000;

/** Call after changing an account's state so the change isn't held back. */
export function invalidateAccount(accountUuid: string) {
  invalidate('auth:account:' + accountUuid);
}
export async function requireSession(req: NextRequest, roles: Role[]): Promise<AuthedRequest> {
  const secret = requireSecret();
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!session) throw new HttpError(401, 'Your session has ended. Sign in again.');

  const [account, epoch] = await Promise.all([
    cached('auth:account:' + session.sub, ACCOUNT_CACHE_MS, async () => {
      const { data, error } = await getServiceClient()
        .from('accounts')
        .select('id, account_id, role, display_name, active, session_version')
        .eq('id', session.sub)
        .maybeSingle();
      if (error) throw error;
      return data as Account | null;
    }),
    getSessionEpoch(),
  ]);

  if (!account || !account.active || account.session_version !== session.sv || epoch !== session.ep) {
    throw new HttpError(401, 'Your session has ended. Sign in again.');
  }
  if (account.role !== session.role || roles.indexOf(account.role as Role) === -1) {
    throw new HttpError(403, 'You do not have access to this action.');
  }

  return { session, account: account as Account };
}

/** Issues a fresh hard-expiry session cookie for an account. */
export async function setSessionCookie(res: NextResponse, account: Account, epoch: number): Promise<SessionPayload> {
  const secret = requireSecret();
  const iat = Math.floor(Date.now() / 1000);
  const lifetime = ROLE_SESSION_SECONDS[account.role];

  const payload: SessionPayload = {
    sub: account.id,
    aid: account.account_id,
    role: account.role,
    name: account.display_name,
    sv: account.session_version,
    ep: epoch,
    iat,
    exp: iat + lifetime,
  };

  res.cookies.set(SESSION_COOKIE, await signSession(payload, secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: lifetime,
  });
  for (const retired of RETIRED_SESSION_COOKIES) res.cookies.delete(retired);

  return payload;
}

export function clearSessionCookies(res: NextResponse) {
  res.cookies.delete(SESSION_COOKIE);
  for (const retired of RETIRED_SESSION_COOKIES) res.cookies.delete(retired);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function audit(actor: string, action: string, target: string | null = null, details: string | null = null) {
  const { error } = await getServiceClient().from('event_audit_logs').insert({ action, actor, target, details });
  // Audit failures must never break the action that was already performed.
  if (error) console.error('[audit]', action, error.message);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const WINDOW_MINUTES = 15;

/**
 * Limits are keyed on (account, IP) so one attacker hammering an admin's ID
 * locks out only their own attempts, not the admin. The per-account ceiling
 * still caps a distributed attack.
 *
 * The per-IP ceiling is deliberately high: a whole venue on one Wi-Fi shares a
 * single public IP, so a tight per-IP cap would lock out every participant at
 * once after a few dozen honest typos. It only exists to stop one address
 * spraying hundreds of IDs.
 */
const LIMITS = {
  perAccountAndIp: 5,
  perAccount: 50,
  perIp: 500,
};

export async function assertNotRateLimited(key: string, ip: string) {
  const db = getServiceClient();
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

  const count = async (filters: { account_id?: string; ip?: string }) => {
    let query = db
      .from('auth_login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('success', false)
      .gte('attempted_at', since);
    if (filters.account_id) query = query.eq('account_id', filters.account_id);
    if (filters.ip) query = query.eq('ip', filters.ip);
    const { count: total, error } = await query;
    if (error) throw error;
    // Count-only requests don't carry an error body, so a failed query can
    // come back as { count: null, error: null }. Treating that as zero would
    // switch rate limiting off — fail closed instead.
    if (total === null || total === undefined) throw new Error('Rate limit check unavailable');
    return total;
  };

  const [pair, account, address] = await Promise.all([
    count({ account_id: key, ip }),
    count({ account_id: key }),
    count({ ip }),
  ]);

  if (pair >= LIMITS.perAccountAndIp || account >= LIMITS.perAccount || address >= LIMITS.perIp) {
    throw new HttpError(429, 'Too many failed attempts. Wait ' + WINDOW_MINUTES + ' minutes and try again.');
  }
}

export async function recordAttempt(key: string, ip: string, success: boolean) {
  const { error } = await getServiceClient().from('auth_login_attempts').insert({ account_id: key, ip, success });
  if (error) console.error('[rate-limit]', error.message);
}
