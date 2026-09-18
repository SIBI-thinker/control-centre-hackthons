import 'server-only';
import { HttpError, requireString } from '@/lib/server/http';
import { ALL_DISPLAYS_TARGET } from '@/lib/supabase';

const ALERT_TYPES = ['INFO', 'WARNING', 'ALERT', 'SUCCESS', 'URGENT', 'ANNOUNCEMENT'];
const ANIMATIONS = ['GLITCH', 'HUD', 'SLIDE', 'WARNING', 'PULSE', 'FADE'];

/** 7 days — long enough for any event, short enough to catch unit mistakes. */
const MAX_ALERT_SECONDS = 7 * 24 * 60 * 60;

export type AlertInput = {
  title: string;
  message: string;
  type: string;
  animation: string;
  duration: number;
  target: string;
};

export function parseTarget(value: unknown): string {
  if (value === undefined || value === null || value === '') return ALL_DISPLAYS_TARGET;
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid target.');
  if (value === ALL_DISPLAYS_TARGET) return value;
  if (/^(BATCH|NODE):[A-Za-z0-9 ._-]{1,60}$/.test(value)) return value;
  if (/^ROOM:[0-9a-f-]{36}$/i.test(value)) return value;
  throw new HttpError(400, 'Invalid target.');
}

/** Upper-cased code for rooms/teams: letters, digits, space, dot, dash, underscore. */
export function parseCode(value: unknown, field: string, allowSpaces: boolean): string {
  if (typeof value !== 'string') throw new HttpError(400, field + ' is required.');
  const code = value.trim().toUpperCase();
  const pattern = allowSpaces ? /^[A-Z0-9][A-Z0-9 ._-]{0,39}$/ : /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
  if (!pattern.test(code)) {
    throw new HttpError(400, field + ' must be 1–40 characters: letters, numbers' + (allowSpaces ? ', spaces' : '') + ', dot, dash, underscore.');
  }
  return code;
}

export function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Maps Postgres unique-violation to a friendly 409. */
export function isUniqueViolation(error: { code?: string } | null): boolean {
  return Boolean(error && error.code === '23505');
}

export function parseAlert(body: Record<string, unknown>): AlertInput {
  const type = String(body.type ?? '');
  const animation = String(body.animation ?? '');
  const duration = Number(body.duration);

  if (ALERT_TYPES.indexOf(type) === -1) throw new HttpError(400, 'Invalid alert type.');
  if (ANIMATIONS.indexOf(animation) === -1) throw new HttpError(400, 'Invalid animation.');
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_ALERT_SECONDS) {
    throw new HttpError(400, 'Duration must be between 1 second and 7 days.');
  }

  return {
    title: requireString(body.title, 'Title', 120),
    message: requireString(body.message, 'Message', 500),
    type,
    animation,
    duration,
    target: parseTarget(body.target),
  };
}

export function parseUuid(value: unknown, field: string = 'id'): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new HttpError(400, 'Invalid ' + field + '.');
  return value;
}

export function parseInteger(value: unknown, field: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, field + ' is out of range.');
  return n;
}
