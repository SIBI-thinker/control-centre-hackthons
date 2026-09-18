'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export type IssueCategory = 'technical' | 'wifi' | 'power' | 'food' | 'medical' | 'other';
export type IssuePriority = 'low' | 'normal' | 'urgent';
export type IssueStatus = 'open' | 'acknowledged' | 'resolved';

export type IssueMessage = {
  id: string;
  issue_id: string;
  author_label: string;
  author_role: 'admin' | 'operator' | 'participant';
  body: string;
  created_at: string;
};

export type Issue = {
  id: string;
  room_id: string | null;
  team_id: string | null;
  room_code: string | null;
  team_name: string | null;
  raised_by_label: string;
  raised_by_role: 'admin' | 'operator' | 'participant';
  category: IssueCategory;
  priority: IssuePriority;
  title: string;
  description: string;
  status: IssueStatus;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  messages: IssueMessage[];
};

export const CATEGORY_OPTIONS: { value: IssueCategory; label: string }[] = [
  { value: 'technical', label: 'Technical' },
  { value: 'wifi', label: 'Wi-Fi / network' },
  { value: 'power', label: 'Power / charging' },
  { value: 'food', label: 'Food / water' },
  { value: 'medical', label: 'Medical' },
  { value: 'other', label: 'Other' },
];

export const PRIORITY_OPTIONS: { value: IssuePriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'urgent', label: 'Urgent' },
];

export function categoryLabel(value: string) {
  return CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value;
}

/** Polls the caller's visible issues. 5s keeps staff alerts prompt without realtime. */
export function useIssues(intervalMs: number = 5000) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const { data, error: apiError } = await api<{ issues: Issue[] }>('GET', '/api/issues');
    if (data) {
      setIssues(data.issues);
      setError(null);
    } else if (apiError) {
      setError(apiError.message);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    refetch();
    const interval = setInterval(refetch, intervalMs);
    return () => clearInterval(interval);
  }, [refetch, intervalMs]);

  return { issues, loaded, error, refetch };
}

export function raiseIssue(input: {
  category: IssueCategory;
  priority: IssuePriority;
  title: string;
  description: string;
  room_id?: string | null;
  team_id?: string | null;
}) {
  return api<{ issue: Issue }>('POST', '/api/issues', input);
}

export function setIssueStatus(id: string, status: IssueStatus) {
  return api('PATCH', '/api/issues/' + id, { status });
}

export function replyToIssue(id: string, body: string) {
  return api<{ message: IssueMessage }>('POST', '/api/issues/' + id + '/messages', { body });
}

// ---------------------------------------------------------------------------
// New-issue alerts (sound)
// ---------------------------------------------------------------------------

function beep(ctx: AudioContext, freq: number, start: number, duration: number, volume: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration);
}

let audioCtx: AudioContext | null = null;
function getAudio(): AudioContext | null {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

export function playIssueSound(urgent: boolean) {
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  if (urgent) {
    // Siren-like: alternating tones, clearly different from a normal issue.
    for (let i = 0; i < 4; i++) {
      beep(ctx, 880, t + i * 0.3, 0.14, 0.25);
      beep(ctx, 660, t + i * 0.3 + 0.15, 0.14, 0.25);
    }
  } else {
    beep(ctx, 740, t, 0.12, 0.15);
    beep(ctx, 988, t + 0.16, 0.18, 0.15);
  }
}

/**
 * Watches the issue list for arrivals and plays a sound. Urgent issues that
 * nobody has acknowledged keep sounding every 20s until someone does — a
 * medical issue shouldn't rely on someone glancing at a badge.
 */
export function useIssueAlerts(issues: Issue[], loaded: boolean, soundOn: boolean) {
  const seenRef = useRef<Set<string> | null>(null);
  const [latest, setLatest] = useState<Issue | null>(null);

  useEffect(() => {
    if (!loaded) return;
    if (seenRef.current === null) {
      // First load: everything already open counts as seen.
      seenRef.current = new Set(issues.map((i) => i.id));
      return;
    }
    const fresh = issues.filter((i) => !seenRef.current!.has(i.id));
    fresh.forEach((i) => seenRef.current!.add(i.id));
    if (fresh.length > 0) {
      const urgent = fresh.find((i) => i.priority === 'urgent');
      setLatest(urgent || fresh[0]);
      if (soundOn) playIssueSound(Boolean(urgent));
    }
  }, [issues, loaded, soundOn]);

  const unacknowledgedUrgent = issues.filter((i) => i.priority === 'urgent' && i.status === 'open');

  useEffect(() => {
    if (!soundOn || unacknowledgedUrgent.length === 0) return;
    const interval = setInterval(() => playIssueSound(true), 20000);
    return () => clearInterval(interval);
  }, [soundOn, unacknowledgedUrgent.length]);

  return { latest, dismissLatest: () => setLatest(null), unacknowledgedUrgent };
}

// ---------------------------------------------------------------------------
// Browser push
// ---------------------------------------------------------------------------

export type PushState = 'unsupported' | 'insecure' | 'default' | 'denied' | 'enabled' | 'unconfigured';

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function getPushState(): Promise<PushState> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (!window.isSecureContext) return 'insecure';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub && Notification.permission === 'granted' ? 'enabled' : 'default';
}

/** Asks permission, subscribes this device, and sends a test notification. */
export async function enablePush(): Promise<{ state: PushState; error?: string }> {
  const state = await getPushState();
  if (state === 'unsupported' || state === 'insecure' || state === 'denied') return { state };

  const { data } = await api<{ publicKey: string | null }>('GET', '/api/push/public-key');
  if (!data || !data.publicKey) return { state: 'unconfigured' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { state: permission === 'denied' ? 'denied' : 'default' };

  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(data.publicKey) });
  }

  const json = sub.toJSON();
  const { error } = await api('POST', '/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys, test: true });
  if (error) return { state: 'default', error: error.message };
  return { state: 'enabled' };
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return getPushState();
}
