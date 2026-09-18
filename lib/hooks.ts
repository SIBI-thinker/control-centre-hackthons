'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { EventControlState, ActiveAlert, EventAlert, EventDisplay, EventBatch, AuditLog } from '@/lib/supabase';
import { calcRemaining, isTargetedAt, alertRowExpiresAt, targetPriority } from '@/lib/supabase';
import type { TargetableDisplay } from '@/lib/supabase';
import { api } from '@/lib/api';
import { makeBrand, type Brand } from '@/lib/brand';
import { useInitialBrand } from '@/components/brand-provider';

/*
 * Reads still come straight from Supabase with the anon key — the timer,
 * alerts, displays and batches are display-safe public data.
 *
 * Every WRITE goes through a server API route. The anon key can no longer
 * change anything, so a participant with devtools can't pause the timer or
 * send alerts.
 */

/**
 * Realtime is the fast path, but a venue screen must never sit on stale state
 * if the socket is unsubscribed, throttled, or the table simply isn't in the
 * `supabase_realtime` publication. Every live query pairs its subscription
 * with a low-frequency refetch so the system degrades to polling instead of
 * silently freezing.
 */
function usePollingFallback(refetch: () => void | Promise<void>, intervalMs: number) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    // Deliberately keeps polling while the tab is hidden. A venue screen may be
    // backgrounded, minimised, or on a TV stick that reports itself hidden —
    // pausing there would silently stop alerts on exactly the screens that
    // nobody is watching closely enough to notice.
    const interval = setInterval(() => { refetchRef.current(); }, intervalMs);
    const onVisible = () => { refetchRef.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}

/**
 * The timer and event state.
 *
 * `pollMs` exists because the cost of this hook is multiplied by however many
 * screens are open. A handful of display screens can afford to ask every two
 * seconds; two thousand participant phones cannot, and do not need to — the
 * countdown is computed locally from the state we already hold, so a slower
 * poll only delays noticing a pause, not the ticking clock.
 */
export function useEventState(pollMs: number = 2000) {
  const [state, setState] = useState<EventControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Guards against a slow poll response overwriting a newer row we already have.
  const latestUpdatedAtRef = useRef<number>(0);

  const applyState = useCallback((next: EventControlState) => {
    const stamp = new Date(next.updated_at).getTime();
    if (Number.isFinite(stamp) && stamp < latestUpdatedAtRef.current) return;
    latestUpdatedAtRef.current = Number.isFinite(stamp) ? stamp : latestUpdatedAtRef.current;
    setState(next);
  }, []);

  const fetchState = useCallback(async () => {
    const { data, error } = await supabase.from('event_control_state').select('*').limit(1).maybeSingle();
    if (error) { setError(error.message); }
    else if (data) { applyState(data as EventControlState); }
    setLoading(false);
  }, [applyState]);

  useEffect(() => {
    fetchState();

    const channel = supabase
      .channel('event-control-state')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_control_state' }, (payload: any) => {
        if (payload.new) applyState(payload.new as EventControlState);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchState, applyState]);

  // The alert transport — poll briskly so a broadcast lands within ~2s even
  // with realtime unavailable.
  usePollingFallback(fetchState, pollMs);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, []);

  const remaining = state ? calcRemaining(state, now) : 0;

  return { state, remaining, now, loading, error, refetch: fetchState };
}

/**
 * Event branding for screens that don't otherwise need the timer: sign-in, the
 * portals, the console sidebar. Re-reads slowly so a rename in System Settings
 * reaches every open screen without anybody reloading.
 */
export function useBrand(
  live?: { event_name?: string | null; organization?: string | null } | null,
  pollMs: number = 15000
): Brand {
  // Screens that already poll the event state pass it in; the rest query for
  // themselves. Either way the starting value is the one the server rendered,
  // so no screen flashes the wrong event name.
  const initial = useInitialBrand();
  const [row, setRow] = useState<{ event_name: string | null; organization: string | null } | null>(null);
  const hasLive = Boolean(live);

  const fetchBrand = useCallback(async () => {
    if (hasLive) return;
    const { data } = await supabase.from('event_control_state').select('event_name, organization').limit(1).maybeSingle();
    if (data) setRow(data as { event_name: string | null; organization: string | null });
  }, [hasLive]);

  useEffect(() => { fetchBrand(); }, [fetchBrand]);
  usePollingFallback(fetchBrand, pollMs);

  if (live) return makeBrand(live.event_name, live.organization);
  return row ? makeBrand(row.event_name, row.organization) : initial;
}

export function useAlerts() {
  const [alerts, setAlerts] = useState<EventAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAlerts = useCallback(async () => {
    const { data } = await supabase.from('event_alerts').select('*').order('created_at', { ascending: false }).limit(50);
    if (data) setAlerts(data as EventAlert[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAlerts();

    const channel = supabase
      .channel('event-alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_alerts' }, () => { fetchAlerts(); })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchAlerts]);

  usePollingFallback(fetchAlerts, 15000);

  return { alerts, loading, refetch: fetchAlerts };
}

export function useDisplays() {
  const [displays, setDisplays] = useState<EventDisplay[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDisplays = useCallback(async () => {
    const { data } = await supabase.from('event_displays').select('*').order('created_at', { ascending: true });
    if (data) setDisplays(data as EventDisplay[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDisplays();

    const channel = supabase
      .channel('event-displays')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_displays' }, () => { fetchDisplays(); })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchDisplays]);

  // Heartbeats arrive as row updates — without this the console shows every
  // node as offline once the initial fetch goes stale.
  usePollingFallback(fetchDisplays, 8000);

  return { displays, loading, refetch: fetchDisplays };
}

export function useBatches() {
  const [batches, setBatches] = useState<EventBatch[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBatches = useCallback(async () => {
    const { data } = await supabase.from('event_batches').select('*').order('name', { ascending: true });
    if (data) setBatches(data as EventBatch[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchBatches();

    const channel = supabase
      .channel('event-batches')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_batches' }, () => { fetchBatches(); })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchBatches]);

  usePollingFallback(fetchBatches, 60000);

  return { batches, loading, refetch: fetchBatches };
}

/** Audit trail, read through the API — the anon key can no longer see it. */
export function useAuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLogs = useCallback(async () => {
    const { data } = await api<{ logs: AuditLog[] }>('GET', '/api/admin/audit');
    if (data) setLogs(data.logs);
    setLoading(false);
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  usePollingFallback(fetchLogs, 10000);

  return { logs, loading, refetch: fetchLogs };
}

export type SessionInfo = { accountId: string; name: string; role: 'admin' | 'operator' | 'participant'; expiresAt: number };

/**
 * The signed-in person and their hard session expiry. Re-checked every 30s so
 * a revoked session (PIN changed elsewhere, "end all sessions") is noticed
 * promptly; api() redirects to sign-in on the resulting 401.
 *
 * `expiresAt` is converted into THIS browser's clock. Comparing the server's
 * timestamp against a device whose clock is wrong would otherwise bounce that
 * device to sign-in the moment it loads — and again after every sign-in.
 */
export function useSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);

  const fetchSession = useCallback(async () => {
    const sentAt = Date.now();
    const { data } = await api<SessionInfo & { serverNow: number }>('GET', '/api/auth/session');
    if (!data) return;
    const receivedAt = Date.now();
    // Server clock minus client clock, using the request midpoint.
    const skew = data.serverNow - (sentAt + receivedAt) / 2;
    setSession({ accountId: data.accountId, name: data.name, role: data.role, expiresAt: data.expiresAt - skew });
  }, []);

  useEffect(() => { fetchSession(); }, [fetchSession]);
  // Only used to show who is signed in and count down to expiry, both of which
  // are computed locally from the payload. Checked rarely so a full venue of
  // participants isn't re-authenticating twice a minute each.
  usePollingFallback(fetchSession, 120000);

  return { session, refetch: fetchSession };
}

export type DisplayDeviceStatus = 'checking' | 'paired' | 'unpaired';

/**
 * A kiosk's identity comes from its device token (httpOnly cookie), confirmed
 * by the server on every heartbeat — not from anything stored in the browser.
 *
 * Only a definite 401 unpairs the screen. Network blips and server errors keep
 * the last known identity, so a Wi-Fi hiccup can't blank a venue display.
 */
export function useDisplayDevice(intervalSeconds: number = 10) {
  const [status, setStatus] = useState<DisplayDeviceStatus>('checking');
  const [display, setDisplay] = useState<EventDisplay | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Why we can't reach the server, shown while no identity has loaded yet.
  const [problem, setProblem] = useState<string | null>(null);
  const displayRef = useRef<EventDisplay | null>(null);

  const beat = useCallback(async () => {
    const { data, error } = await api<{ display: EventDisplay }>('POST', '/api/display/heartbeat');
    if (data) {
      displayRef.current = data.display;
      setDisplay(data.display);
      setStatus('paired');
      setProblem(null);
      return;
    }
    if (error && error.status === 401) {
      setProblem(null);
      if (displayRef.current) {
        setNotice(displayRef.current.display_id + ' is no longer paired to this screen. Enter a new pairing code.');
      }
      displayRef.current = null;
      setDisplay(null);
      setStatus('unpaired');
    }
    // Any other failure: keep what we have and try again on the next beat.
    if (error) setProblem(error.message);
  }, []);

  useEffect(() => { beat(); }, [beat]);
  usePollingFallback(beat, Math.max(3, intervalSeconds) * 1000);

  const pair = useCallback(async (code: string) => {
    const { data, error } = await api<{ display: EventDisplay }>('POST', '/api/display/pair', { code });
    if (data) {
      displayRef.current = data.display;
      setDisplay(data.display);
      setStatus('paired');
      setNotice(null);
    }
    return { error };
  }, []);

  const unpair = useCallback(async () => {
    await api('POST', '/api/display/unpair');
    displayRef.current = null;
    setDisplay(null);
    setStatus('unpaired');
    setNotice(null);
  }, []);

  return { status, display, notice, problem, pair, unpair };
}

/**
 * Nudges the server to fire scheduled alerts that are due. There's no
 * background worker, so paired displays drive it; the endpoint is idempotent.
 */
export function useScheduledAlertTrigger(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { api('POST', '/api/alerts/process-scheduled'); };
    tick();
    const interval = setInterval(tick, 5000);
    return () => clearInterval(interval);
  }, [enabled]);
}

/**
 * Per-display alert resolution. Queries the event_alerts table for currently
 * active (EXECUTED, not yet expired) alerts that target this specific display,
 * its batch, or all displays.
 *
 * This replaces the old single-slot `event_control_state.active_alert` approach.
 * Multiple concurrent alerts addressed to different targets can now coexist —
 * each display sees only the alerts meant for it.
 *
 * Priority: NODE > ROOM > BATCH > ALL DISPLAYS (most recent wins within the
 * same tier).
 */
export function useDisplayAlert(
  display: EventDisplay | null,
  displayId: string | null,
  now: number
): ActiveAlert | null {
  const [alert, setAlert] = useState<ActiveAlert | null>(null);

  const targetable: TargetableDisplay | null = display
    ? { display_id: display.display_id, batch: display.batch, room_id: display.room_id }
    : displayId
    ? { display_id: displayId, batch: 'ALL', room_id: null }
    : null;

  // Serialise the identity so useCallback doesn't churn on every render
  const targetKey = targetable
    ? targetable.display_id + '|' + targetable.batch + '|' + (targetable.room_id || '')
    : '';

  const fetchAlert = useCallback(async () => {
    // Only look at alerts executed in the last 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('event_alerts')
      .select('*')
      .eq('execution_status', 'EXECUTED')
      .not('executed_at', 'is', null)
      .gte('executed_at', cutoff)
      .order('executed_at', { ascending: false })
      .limit(20);

    if (!data || data.length === 0) {
      setAlert(null);
      return;
    }

    const nowMs = Date.now();
    const tgt: TargetableDisplay | null = targetKey
      ? { display_id: targetKey.split('|')[0], batch: targetKey.split('|')[1], room_id: targetKey.split('|')[2] || null }
      : null;

    // Find the highest-priority non-expired alert for this display.
    let best: { row: any; priority: number } | null = null;

    for (const row of data) {
      const expiresAt = alertRowExpiresAt(row);
      if (expiresAt <= nowMs) continue;
      if (!isTargetedAt(row.target, tgt)) continue;

      // NODE > ROOM > BATCH > ALL DISPLAYS
      const priority = targetPriority(row.target);

      if (!best || priority > best.priority) {
        best = { row, priority };
      }
    }

    if (!best) {
      setAlert(null);
      return;
    }

    const r = best.row;
    const expiresAt = alertRowExpiresAt(r);
    setAlert({
      id: r.id,
      title: r.title,
      message: r.message,
      type: r.message_type as ActiveAlert['type'],
      animation: r.animation as ActiveAlert['animation'],
      startedAt: new Date(r.executed_at).getTime(),
      expiresAt,
      duration: r.duration_seconds,
      target: r.target,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  useEffect(() => {
    fetchAlert();

    const channel = supabase
      .channel('display-alert-feed-' + (displayId || 'anon'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_alerts' }, () => {
        fetchAlert();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchAlert, displayId]);

  // Poll briskly — same cadence as the state poll so broadcasts land in ~2s
  usePollingFallback(fetchAlert, 2000);

  // Quick expiry: null out the alert as soon as `now` passes its expiresAt,
  // without waiting for the next poll/realtime event.
  useEffect(() => {
    if (alert && now >= alert.expiresAt) {
      setAlert(null);
    }
  }, [alert, now]);

  return alert;
}

// ---------------------------------------------------------------------------
// Admin actions — every one is an authenticated server call
// ---------------------------------------------------------------------------

type AlertDraft = { title: string; message: string; type: string; animation: string; duration: number; target?: string };

export async function sendAlertNow(alert: AlertDraft) {
  return api<{ id: string }>('POST', '/api/admin/alerts', alert);
}

export async function scheduleAlert(alert: AlertDraft, scheduledFor: string) {
  return api<{ id: string }>('POST', '/api/admin/alerts', { ...alert, scheduledFor });
}

export async function cancelScheduledAlert(alertId: string) {
  return api<{ cancelled: boolean }>('POST', '/api/admin/alerts/cancel', { id: alertId });
}

/** Takes ONE live broadcast off air. */
export async function dismissAlertById(alert: { id: string }) {
  return api<{ cleared: number }>('POST', '/api/admin/alerts/dismiss', { ids: [alert.id] });
}

/** Takes every listed live broadcast off air in one action. */
export async function dismissAllAlerts(alerts: { id: string }[]) {
  if (alerts.length === 0) return { data: { cleared: 0 }, error: null };
  return api<{ cleared: number }>('POST', '/api/admin/alerts/dismiss', { ids: alerts.map((a) => a.id) });
}

export async function controlTimer(action: 'start' | 'pause' | 'resume' | 'reset') {
  return api('POST', '/api/admin/timer', { action });
}

export async function adjustTimer(seconds: number) {
  return api('POST', '/api/admin/timer/adjust', { seconds });
}

export async function setTimerDuration(seconds: number) {
  return api('POST', '/api/admin/timer/duration', { seconds });
}

export async function createDisplay(display: { display_id: string; display_name: string; location: string; batch: string }) {
  return api<{ display: EventDisplay }>('POST', '/api/admin/displays', display);
}

export async function toggleDisplay(id: string, enabled: boolean) {
  return api('PATCH', '/api/admin/displays/' + id, { enabled });
}

export async function updateDisplay(id: string, updates: { display_name?: string; location?: string; batch?: string }) {
  return api('PATCH', '/api/admin/displays/' + id, updates);
}

export async function deleteDisplay(id: string) {
  return api('DELETE', '/api/admin/displays/' + id);
}

/** One-time code to pair a kiosk with this display. Shown once; only its hash is stored. */
export async function requestPairingCode(id: string) {
  return api<{ code: string; expiresAt: string; displayId: string }>('POST', '/api/admin/displays/' + id + '/pairing-code');
}

export async function updateEventDetails(updates: { event_name?: string; organization?: string; sound_enabled?: boolean }) {
  return api('PATCH', '/api/admin/settings', updates);
}

/** Changes the signed-in person's own PIN; ends their other sessions. */
export async function changeOwnPin(currentPin: string, newPin: string) {
  return api('POST', '/api/account/pin', { currentPin, newPin });
}

/** Ends every signed-in session except the caller's. */
export async function endAllSessions() {
  return api('POST', '/api/admin/sessions/revoke-all');
}
