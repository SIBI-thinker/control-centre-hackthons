import 'server-only';

/**
 * A very small in-process cache with a time-to-live.
 *
 * The event runs on one laptop serving around 2000 participants. Most of what
 * their pages ask for is identical between everyone in the same room — the
 * phase, the Wi-Fi settings, the revocation epoch — so answering each of those
 * from memory for a few seconds is the difference between a few database
 * queries a second and a few hundred.
 *
 * Deliberately per-process and deliberately short:
 *   - anything cached here is the same for every viewer, never per-person data
 *     beyond a key that already identifies them;
 *   - a stale entry can only ever be a few seconds old, which is well inside
 *     how fast a human notices;
 *   - a second server process would simply have its own copy, never a wrong
 *     one.
 *
 * Writes call `invalidate` so a change an admin just made shows up at once
 * rather than after the TTL.
 */

type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();

/** Keeps the map from growing without bound if keys are per-account. */
const MAX_ENTRIES = 5000;

function prune() {
  const now = Date.now();
  // Drop what has expired first; only if that isn't enough, drop oldest-first
  // (Map preserves insertion order).
  Array.from(store.entries()).forEach(([key, entry]) => {
    if (entry.expires <= now) store.delete(key);
  });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Returns the cached value for `key`, or runs `load` and caches what it
 * returns. A failing `load` is never cached.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const value = await load();
  if (store.size >= MAX_ENTRIES) prune();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/** Forgets one key, or every key starting with `prefix` when it ends in ':'. */
export function invalidate(prefix: string) {
  if (prefix.endsWith(':')) {
    Array.from(store.keys()).forEach((key) => {
      if (key.startsWith(prefix)) store.delete(key);
    });
    return;
  }
  store.delete(prefix);
}

export function clearCache() {
  store.clear();
}
