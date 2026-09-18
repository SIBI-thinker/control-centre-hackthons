import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { generatePin, hashPin } from '@/lib/server/pin';
import type { Role } from '@/lib/supabase';

/** Prefix and zero-padding for generated IDs, e.g. P-0001, OP-001. */
export const ID_PREFIX: Record<Role, { prefix: string; pad: number }> = {
  admin: { prefix: 'ADM-', pad: 2 },
  operator: { prefix: 'OP-', pad: 3 },
  participant: { prefix: 'P-', pad: 4 },
};

export const ACCOUNT_ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;

export function normalizeAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toUpperCase();
  return id ? id : null;
}

export function assertAccountId(id: string, context: string = '') {
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw new HttpError(400, context + 'ID "' + id + '" must be 2–40 characters: letters, numbers, dot, dash, underscore.');
  }
}

/**
 * Hands out the next free sequential IDs for a prefix, e.g. P-0001, P-0002.
 * Gaps left by deleted accounts are not reused, so an ID never points at two
 * different people over the event.
 */
export async function nextSequentialIds(
  table: 'accounts' | 'teams',
  column: 'account_id' | 'code',
  prefix: string,
  count: number,
  pad: number,
  reserved: Set<string> = new Set()
): Promise<string[]> {
  if (count === 0) return [];
  const { data, error } = await getServiceClient().from(table).select(column).ilike(column, prefix + '%');
  if (error) throw error;

  let max = 0;
  const pattern = new RegExp('^' + prefix.replace(/[-.]/g, '\\$&') + '(\\d+)$');
  (data ?? []).forEach((row: Record<string, string>) => {
    const match = pattern.exec(String(row[column]).toUpperCase());
    if (match) max = Math.max(max, Number(match[1]));
  });
  reserved.forEach((id) => {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  });

  const ids: string[] = [];
  for (let n = max + 1; ids.length < count; n++) {
    const candidate = prefix + String(n).padStart(pad, '0');
    if (!reserved.has(candidate)) ids.push(candidate);
  }
  return ids;
}

/**
 * Generates and hashes PINs. PBKDF2 at 600k iterations is ~130ms each, so this
 * runs in small parallel batches (Node's crypto thread pool) — 300 people take
 * seconds, not most of a minute, which keeps big imports inside proxy timeouts.
 */
export async function issuePins(count: number): Promise<{ pin: string; hash: string }[]> {
  const pins = Array.from({ length: count }, () => generatePin());
  const results: { pin: string; hash: string }[] = new Array(count);
  const BATCH = 8;
  for (let start = 0; start < count; start += BATCH) {
    const slice = pins.slice(start, start + BATCH);
    const hashes = await Promise.all(slice.map((pin) => hashPin(pin)));
    hashes.forEach((hash, offset) => {
      results[start + offset] = { pin: slice[offset], hash };
    });
  }
  return results;
}

export async function assertAccountIdsFree(ids: string[]) {
  if (ids.length === 0) return;
  const db = getServiceClient();
  const taken: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('accounts').select('account_id').in('account_id', ids.slice(i, i + 200));
    if (error) throw error;
    (data ?? []).forEach((row) => taken.push(row.account_id));
  }
  if (taken.length > 0) {
    throw new HttpError(409, 'Already in use: ' + taken.slice(0, 10).join(', ') + (taken.length > 10 ? ' and ' + (taken.length - 10) + ' more' : '') + '.');
  }
}

/** Refuses changes that would leave the event with no active admin. */
export async function assertOtherActiveAdminExists(excludingAccountUuid: string) {
  const { count, error } = await getServiceClient()
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true)
    .neq('id', excludingAccountUuid);
  if (error) throw error;
  if (count === null || count === undefined) throw new Error('Admin count unavailable');
  if (count === 0) throw new HttpError(409, 'This is the only active admin. Create or activate another admin first.');
}
