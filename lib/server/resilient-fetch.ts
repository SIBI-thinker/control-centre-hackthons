import 'server-only';

/**
 * The fetch the server's Supabase client uses.
 *
 * Everything the server does goes over the internet to Supabase, from one
 * laptop on venue Wi-Fi. That link will drop for a second or two at some point
 * during the event. Without this, a blip surfaces as a wall of
 * "TypeError: fetch failed" in the log and a generic "Server error" on every
 * screen, with nothing saying what actually went wrong.
 *
 * What it does:
 *   - Retries READS (GET/HEAD) that fail at the network level, twice, with a
 *     short pause. A reconnecting Wi-Fi usually recovers inside that window,
 *     so most blips never reach anyone's screen.
 *   - Never retries WRITES. If a POST's connection dropped after Supabase had
 *     already applied it, sending it again would apply it twice — a duplicate
 *     alert, a second import. A failed write is reported, not repeated.
 *   - Puts a time limit on every request, so a connection that hangs instead
 *     of failing can't pile up waiting requests on the laptop until it stalls.
 *   - Reports a failure as DB_UNREACHABLE with the underlying reason (DNS
 *     lookup failed, timed out, connection reset…), so the log says what
 *     happened and `handle()` can answer 503 with a clear message.
 */

export const DB_UNREACHABLE = 'DB_UNREACHABLE';

const READ_TIMEOUT_MS = 15_000;
// Writes include audio clip uploads, which can be slow on venue internet.
const WRITE_TIMEOUT_MS = 60_000;
const READ_RETRY_DELAYS_MS = [300, 1000];

/** Pulls the useful part out of undici's "fetch failed" and its `cause`. */
export function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'request timed out';
  const cause = e?.cause;
  if (cause?.code) return cause.code + (cause.message ? ' (' + cause.message + ')' : '');
  if (cause?.message) return cause.message;
  return e?.message || 'network error';
}

class DatabaseUnreachableError extends Error {
  code = DB_UNREACHABLE;
  constructor(reason: string) {
    super('Cannot reach Supabase: ' + reason);
    this.name = 'DatabaseUnreachable';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const timeout = isRead ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  const attempts = isRead ? READ_RETRY_DELAYS_MS.length + 1 : 1;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(READ_RETRY_DELAYS_MS[attempt - 1]);

    // Our time limit, combined by hand with any signal the caller passed
    // (AbortSignal.any isn't in this project's TypeScript lib).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), timeout);
    const onCallerAbort = () => controller.abort(init?.signal?.reason);
    init?.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      // Only network-level failures throw here; an HTTP error status (400,
      // 409, 500) is a real answer from Supabase and is returned as-is.
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      // The caller cancelled on purpose — not an outage.
      if (init?.signal?.aborted) throw err;
      lastError = controller.signal.aborted ? new DOMException('timed out', 'TimeoutError') : err;
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  throw new DatabaseUnreachableError(describeNetworkError(lastError));
}

/** True for the error object supabase-js hands back after a network failure. */
export function isDatabaseUnreachable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === DB_UNREACHABLE) return true;
  // Belt and braces: a network failure that bypassed the wrapper.
  return typeof e.message === 'string' && e.message.indexOf('fetch failed') !== -1;
}
