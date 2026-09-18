import 'server-only';
import { pbkdf2, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

/**
 * PIN hashing for personal accounts.
 *
 * PBKDF2-HMAC-SHA256, 600k iterations (OWASP's current floor for this KDF),
 * with a random 16-byte salt per account. Stored as:
 *
 *   pbkdf2_sha256$<iterations>$<salt base64>$<hash base64>
 *
 * Replaces the old scheme — one pass of SHA-256 over a fixed "yhack26:" prefix
 * — which let a leaked hash be reversed in under a second.
 *
 * scripts/create-admin.mjs duplicates this format; keep the two in step.
 */

const pbkdf2Async = promisify(pbkdf2);

const ALGORITHM = 'pbkdf2_sha256';
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;

/** Digits only, 6–12 long. Returns an error message, or null if acceptable. */
export function validatePin(pin: unknown): string | null {
  if (typeof pin !== 'string') return 'PIN is required.';
  if (!/^\d+$/.test(pin)) return 'PIN must contain digits only.';
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    return 'PIN must be ' + PIN_MIN_LENGTH + '–' + PIN_MAX_LENGTH + ' digits.';
  }
  return null;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await pbkdf2Async(pin, salt, ITERATIONS, KEY_BYTES, 'sha256')) as Buffer;
  return [ALGORITHM, ITERATIONS, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000) return false;

  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  if (expected.length !== KEY_BYTES) return false;

  const derived = (await pbkdf2Async(pin, salt, iterations, KEY_BYTES, 'sha256')) as Buffer;
  return timingSafeEqual(derived, expected);
}

/**
 * A real hash of a random PIN, verified against when the account ID doesn't
 * exist — so "no such account" takes as long as "wrong PIN" and response time
 * can't be used to discover valid IDs.
 */
let decoyHash: Promise<string> | null = null;
export function getDecoyHash(): Promise<string> {
  if (!decoyHash) decoyHash = hashPin(generatePin(PIN_MAX_LENGTH));
  return decoyHash;
}

/** Uniformly random numeric PIN (crypto-grade). */
export function generatePin(length: number = PIN_MIN_LENGTH): string {
  let pin = '';
  for (let i = 0; i < length; i++) pin += String(randomInt(0, 10));
  return pin;
}
