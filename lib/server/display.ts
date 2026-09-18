import 'server-only';
import { createHash, randomBytes, randomInt } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import type { EventDisplay } from '@/lib/supabase';

/**
 * Display pairing.
 *
 * An admin generates a short one-time pairing code for a registered display.
 * Typing it into a kiosk exchanges it for a long-lived device token kept in an
 * httpOnly cookie; the token is what authorises that kiosk's heartbeats.
 *
 * Both are stored only as SHA-256 hashes. That's appropriate here (unlike
 * PINs): the device token is 256 random bits, and the pairing code lives 15
 * minutes behind a rate limit.
 */

export const DISPLAY_COOKIE = 'yhack_display';
export const DISPLAY_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const PAIRING_CODE_TTL_MINUTES = 15;

// No 0/O or 1/I/L — codes get read off one screen and typed on another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}

export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) {
    if (CODE_ALPHABET.indexOf(code[i]) === -1) return null;
  }
  return code;
}

export function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function setDisplayCookie(res: NextResponse, token: string) {
  res.cookies.set(DISPLAY_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DISPLAY_TOKEN_MAX_AGE_SECONDS,
  });
}

/**
 * Authenticates a kiosk by its device token cookie and returns its display
 * row. 401 means the screen is not (or no longer) paired.
 */
export async function requireDevice(req: NextRequest): Promise<EventDisplay> {
  const token = req.cookies.get(DISPLAY_COOKIE)?.value;
  if (!token) throw new HttpError(401, 'This screen is not paired.');

  const db = getServiceClient();
  const { data: credential, error } = await db
    .from('display_credentials')
    .select('display_uuid')
    .eq('device_token_hash', sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!credential) throw new HttpError(401, 'This screen is no longer paired.');

  const { data: display, error: displayError } = await db
    .from('event_displays')
    .select('*')
    .eq('id', credential.display_uuid)
    .maybeSingle();
  if (displayError) throw displayError;
  if (!display) throw new HttpError(401, 'This screen is no longer paired.');
  return display as EventDisplay;
}
