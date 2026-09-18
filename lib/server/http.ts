import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { ServerConfigError } from '@/lib/server/db';
import { isDatabaseUnreachable } from '@/lib/server/resilient-fetch';

/**
 * During an outage every open screen keeps polling, and each failure used to
 * print a full stack trace — hundreds of identical lines a minute that bury
 * everything else. Log the first one, then a count every so often.
 */
const OUTAGE_LOG_EVERY_MS = 15_000;
let outageFailures = 0;
let outageLastLogged = 0;

function logOutage(req: NextRequest, err: unknown) {
  outageFailures++;
  const now = Date.now();
  if (now - outageLastLogged < OUTAGE_LOG_EVERY_MS) return;
  const message = (err as { message?: string })?.message || String(err);
  console.error(
    '[db] unreachable — ' + message + ' (' + outageFailures + ' failed request(s) since last report; latest ' +
      req.method + ' ' + req.nextUrl.pathname + ')'
  );
  outageFailures = 0;
  outageLastLogged = now;
}

/** An error that should reach the client with a specific status and message. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json<T>(data: T, status: number = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** A downloadable file response — the error handling of `handle` still applies. */
export function fileResponse(body: string, contentType: string, filename: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'attachment; filename="' + filename.replace(/[^A-Za-z0-9._-]/g, '_') + '"',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Wraps a route handler so every failure becomes a clean JSON error. Unknown
 * errors are logged server-side and reported generically — never leaking
 * stack traces or database messages to the caller.
 */
export function handle<C = unknown>(fn: (req: NextRequest, ctx: C) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof ServerConfigError) return json({ error: err.message }, 503);
      if (isDatabaseUnreachable(err)) {
        logOutage(req, err);
        // 503, not 500: nothing is broken, the connection is down and the
        // screens will recover on their next poll without anyone reloading.
        return json({ error: 'Lost connection to the database. Retrying automatically…' }, 503);
      }
      console.error('[api]', req.method, req.nextUrl.pathname, err);
      return json({ error: 'Server error' }, 500);
    }
  };
}

export async function readJson<T extends Record<string, unknown>>(req: NextRequest): Promise<Partial<T>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

/**
 * Best-effort client IP for rate limiting.
 *
 * Hosted behind a Cloudflare Tunnel, every request reaches Next from the local
 * `cloudflared` process, so the socket address is the same for everyone.
 * Cloudflare puts the real visitor address in CF-Connecting-IP.
 *
 * That header is only trustworthy while the origin is unreachable except
 * through the tunnel — run `next start -H 127.0.0.1` so nobody can connect
 * directly and forge it.
 */
export function clientIp(req: NextRequest): string {
  const cloudflare = req.headers.get('cf-connecting-ip');
  if (cloudflare) return cloudflare.trim().slice(0, 64);
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
  return (req.headers.get('x-real-ip') || req.ip || 'unknown').slice(0, 64);
}

export function requireString(value: unknown, field: string, max: number, min: number = 1): string {
  if (typeof value !== 'string') throw new HttpError(400, field + ' is required.');
  const trimmed = value.trim();
  if (trimmed.length < min) throw new HttpError(400, field + ' is required.');
  if (trimmed.length > max) throw new HttpError(400, field + ' must be at most ' + max + ' characters.');
  return trimmed;
}
