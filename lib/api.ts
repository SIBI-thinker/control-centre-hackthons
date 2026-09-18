/**
 * Browser-side calls to the server API. All writes go through here now that
 * the anon key can no longer change anything.
 */

export type ApiError = { message: string; status: number };
export type ApiResult<T> = { data: T | null; error: ApiError | null };

// Staff/participant routes: a 401 here means the session ended, so send the
// person to sign in. Kiosk and login routes handle their own 401s.
function redirectsOnUnauthorized(path: string): boolean {
  return ['/api/admin', '/api/account', '/api/participant', '/api/operator', '/api/issues', '/api/push'].some((prefix) => path.indexOf(prefix) === 0) || path === '/api/auth/session';
}

let redirecting = false;

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { data: null, error: { message: 'Network error — check the connection and try again.', status: 0 } };
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (res.status === 401 && redirectsOnUnauthorized(path) && typeof window !== 'undefined' && !redirecting) {
    redirecting = true;
    window.location.href = '/login?reason=expired';
  }

  if (!res.ok) {
    return { data: null, error: { message: (payload && payload.error) || 'Request failed (' + res.status + ').', status: res.status } };
  }
  return { data: payload as T, error: null };
}
