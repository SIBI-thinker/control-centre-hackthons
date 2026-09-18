/**
 * Signed session tokens, shared by the Edge middleware and Node API routes.
 *
 * Web Crypto only (no Node `crypto` import) so the same code verifies a token
 * in middleware and in route handlers.
 *
 * Token format:  base64url(JSON payload) "." base64url(HMAC-SHA256 signature)
 *
 * The signature is what the previous cookie lacked — it carried a bare
 * `{ token, expires }` JSON blob that anyone could hand-write with a future
 * `expires` and walk into the console without a PIN.
 *
 * Expiry is HARD: a session ends a fixed time after sign-in and is never
 * extended by activity.
 */

export const SESSION_COOKIE = 'yhack_session';

/** Cookie names from earlier builds, cleared on login/logout so none linger. */
export const RETIRED_SESSION_COOKIES = ['yhack_admin', 'yhack_admin_v2'];

export type Role = 'admin' | 'operator' | 'participant';

/** Hard session lifetime per role, in seconds. */
export const ROLE_SESSION_SECONDS: Record<Role, number> = {
  admin: 60 * 60,
  operator: 60 * 60,
  participant: 2 * 60 * 60,
};

/** Where each role lands after signing in. */
export const ROLE_HOME: Record<Role, string> = {
  admin: '/',
  operator: '/operator',
  participant: '/participant',
};

export type SessionPayload = {
  /** accounts.id (uuid) */
  sub: string;
  /** human account ID, e.g. ADM-SIBI */
  aid: string;
  role: Role;
  name: string;
  /** accounts.session_version at issue time — bumped to revoke one account */
  sv: number;
  /** auth_settings.session_epoch at issue time — bumped to revoke everyone */
  ep: number;
  /** issued at, epoch seconds */
  iat: number;
  /** expires at, epoch seconds */
  exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Returns the configured secret, or null when it is missing or too short to be safe. */
export function getSessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return body + '.' + toBase64Url(new Uint8Array(signature));
}

const ROLES: Role[] = ['admin', 'operator', 'participant'];

/**
 * Verifies signature and expiry. Returns the payload, or null for anything
 * forged, tampered, malformed, or expired.
 *
 * This does NOT check revocation (session_version / session_epoch) — that
 * needs the database and happens in the API routes.
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid = false;
  try {
    // crypto.subtle.verify compares in constant time.
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(signature), encoder.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body)));
  } catch {
    return null;
  }

  if (
    typeof payload.sub !== 'string' ||
    typeof payload.aid !== 'string' ||
    ROLES.indexOf(payload.role) === -1 ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number'
  ) {
    return null;
  }

  // Hard expiry, and never trust a token whose lifetime exceeds its role's cap.
  if (payload.exp <= nowSeconds) return null;
  if (payload.exp - payload.iat > ROLE_SESSION_SECONDS[payload.role]) return null;

  return payload;
}
