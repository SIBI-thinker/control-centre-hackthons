import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
});

export type TimerStatus = 'NOT_STARTED' | 'RUNNING' | 'PAUSED' | 'ENDED';
export type AlertType = 'INFO' | 'WARNING' | 'ALERT' | 'SUCCESS' | 'URGENT' | 'ANNOUNCEMENT';
export type AlertAnimation = 'GLITCH' | 'HUD' | 'SLIDE' | 'WARNING' | 'PULSE' | 'FADE';
export type AlertStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

export type EventControlState = {
  id: string;
  event_name: string;
  organization: string;
  timer_status: TimerStatus;
  duration_seconds: number;
  remaining_seconds: number;
  started_at: string | null;
  paused_at: string | null;
  ends_at: string | null;
  active_alert: ActiveAlert | null;
  timezone: string;
  sound_enabled: boolean;
  heartbeat_interval: number;
  offline_timeout: number;
  updated_at: string;
};

export type ActiveAlert = {
  id: string;
  title: string;
  message: string;
  type: AlertType;
  animation: AlertAnimation;
  startedAt: number;
  expiresAt: number;
  duration: number;
  target?: string;
};

export type EventAlert = {
  id: string;
  title: string;
  message: string;
  message_type: AlertType;
  animation: AlertAnimation;
  duration_seconds: number;
  target: string;
  scheduled_for: string | null;
  execution_status: AlertStatus;
  executed_at: string | null;
  created_at: string;
};

export type EventDisplay = {
  id: string;
  display_id: string;
  display_name: string;
  location: string;
  batch: string;
  room_id: string | null;
  enabled: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
};

export type EventBatch = {
  id: string;
  name: string;
  created_at: string;
};

export type Room = {
  id: string;
  code: string;
  name: string;
  location: string | null;
  created_at: string;
};

export type Team = {
  id: string;
  code: string;
  name: string;
  room_id: string | null;
  created_at: string;
};

export type Role = 'admin' | 'operator' | 'participant';

export type AccountSummary = {
  id: string;
  account_id: string;
  role: Role;
  display_name: string;
  active: boolean;
  team_id: string | null;
  room_ids: string[];
  last_login_at: string | null;
  created_at: string;
};

/** Returned once, at creation or PIN reset — never retrievable again. */
export type IssuedCredential = {
  account_id: string;
  display_name: string;
  role: Role;
  pin: string;
  team_name?: string | null;
  room_label?: string | null;
};

export type AuditLog = {
  id: string;
  action: string;
  actor: string;
  target: string | null;
  details: string | null;
  created_at: string;
};

/* ---------------------------------------------------------------------------
 * Alert targeting
 * A target string is one of:
 *   'ALL DISPLAYS'      -> every registered node
 *   'ROOM:<room uuid>'  -> every node in that room
 *   'BATCH:<name>'      -> every node assigned to that batch (+ 'ALL' house nodes)
 *   'NODE:<display_id>' -> one specific device
 * Bare strings written by older builds are treated as a batch name (or a
 * display id) so historical rows keep resolving.
 * ------------------------------------------------------------------------- */
export const ALL_DISPLAYS_TARGET = 'ALL DISPLAYS';
export const BATCH_TARGET_PREFIX = 'BATCH:';
export const NODE_TARGET_PREFIX = 'NODE:';
export const ROOM_TARGET_PREFIX = 'ROOM:';

export function roomTarget(roomId: string): string {
  return ROOM_TARGET_PREFIX + roomId;
}

/** More specific targets win when several alerts reach one screen. */
export function targetPriority(target: string | null | undefined): number {
  if (!target) return 1;
  if (target.startsWith(NODE_TARGET_PREFIX)) return 4;
  if (target.startsWith(ROOM_TARGET_PREFIX)) return 3;
  if (target.startsWith(BATCH_TARGET_PREFIX)) return 2;
  return 1;
}

export function batchTarget(name: string): string {
  return BATCH_TARGET_PREFIX + name;
}

export function nodeTarget(displayId: string): string {
  return NODE_TARGET_PREFIX + displayId;
}

/** Pass room names (id → label) to show "ROOM · F101" instead of a uuid. */
export function describeTarget(target?: string | null, roomNames?: Record<string, string>): string {
  if (!target || target === ALL_DISPLAYS_TARGET || target === 'ALL') return ALL_DISPLAYS_TARGET;
  if (target.startsWith(NODE_TARGET_PREFIX)) return 'NODE · ' + target.slice(NODE_TARGET_PREFIX.length);
  if (target.startsWith(ROOM_TARGET_PREFIX)) {
    const id = target.slice(ROOM_TARGET_PREFIX.length);
    return 'ROOM · ' + ((roomNames && roomNames[id]) || 'unknown room');
  }
  if (target.startsWith(BATCH_TARGET_PREFIX)) return 'BATCH · ' + target.slice(BATCH_TARGET_PREFIX.length);
  return target;
}

export type TargetableDisplay = { display_id: string; batch: string; room_id?: string | null };

export function isTargetedAt(target: string | null | undefined, display: TargetableDisplay | null): boolean {
  if (!target || target === ALL_DISPLAYS_TARGET || target === 'ALL') return true;
  // An unidentified screen only ever receives venue-wide broadcasts.
  if (!display) return false;
  if (target.startsWith(NODE_TARGET_PREFIX)) {
    return display.display_id === target.slice(NODE_TARGET_PREFIX.length);
  }
  // Checked before the batch fallback: a house screen (batch ALL) must NOT
  // pick up another room's announcements.
  if (target.startsWith(ROOM_TARGET_PREFIX)) {
    return Boolean(display.room_id) && display.room_id === target.slice(ROOM_TARGET_PREFIX.length);
  }
  const batch = target.startsWith(BATCH_TARGET_PREFIX) ? target.slice(BATCH_TARGET_PREFIX.length) : target;
  // Nodes assigned to 'ALL' are house screens and carry every batch message.
  if (display.batch === 'ALL') return true;
  return display.batch === batch || display.display_id === batch;
}

export const ALERT_TEMPLATES = [
  { title: 'HACKATHON STARTING', message: 'The hackathon is about to begin. Get ready to build.', type: 'URGENT' as AlertType, animation: 'GLITCH' as AlertAnimation, duration: 60 },
  { title: 'BREAK STARTING', message: 'A short break is starting now. Stretch and recharge.', type: 'WARNING' as AlertType, animation: 'SLIDE' as AlertAnimation, duration: 300 },
  { title: 'LUNCH BREAK', message: 'Lunch break is now in progress. Enjoy your meal.', type: 'INFO' as AlertType, animation: 'HUD' as AlertAnimation, duration: 900 },
  { title: 'FINAL HOUR', message: 'Only one hour remains. Make every moment count.', type: 'WARNING' as AlertType, animation: 'PULSE' as AlertAnimation, duration: 120 },
  { title: '30 MINUTES REMAINING', message: 'Thirty minutes left until submissions close.', type: 'URGENT' as AlertType, animation: 'WARNING' as AlertAnimation, duration: 60 },
  { title: '10 MINUTES REMAINING', message: 'Only ten minutes remain. Finalize your submissions.', type: 'URGENT' as AlertType, animation: 'GLITCH' as AlertAnimation, duration: 60 },
  { title: '5 MINUTES REMAINING', message: 'Five minutes left. Submit your projects now.', type: 'URGENT' as AlertType, animation: 'WARNING' as AlertAnimation, duration: 30 },
  { title: 'SUBMISSION CLOSING', message: 'Submissions are closing soon. Upload your final build.', type: 'ALERT' as AlertType, animation: 'HUD' as AlertAnimation, duration: 60 },
  { title: 'SUBMISSIONS CLOSED', message: 'Submissions are now closed. No further uploads accepted.', type: 'ALERT' as AlertType, animation: 'GLITCH' as AlertAnimation, duration: 120 },
  { title: 'HACKATHON ENDED', message: 'The hackathon has ended. Thank you all for participating.', type: 'SUCCESS' as AlertType, animation: 'FADE' as AlertAnimation, duration: 300 },
  { title: 'GENERAL ANNOUNCEMENT', message: 'Please check the event dashboard for updates.', type: 'ANNOUNCEMENT' as AlertType, animation: 'SLIDE' as AlertAnimation, duration: 60 },
];

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600).toString().padStart(2, '0');
  const m = Math.floor((safe % 3600) / 60).toString().padStart(2, '0');
  const s = (safe % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatShortTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60).toString().padStart(2, '0');
  const s = (safe % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ---------------------------------------------------------------------------
 * Live-alert lifecycle
 * Displays resolve their own broadcast straight from `event_alerts`, so an
 * alert row IS the source of truth: it is on air from `executed_at` until
 * `executed_at + duration_seconds`, unless an operator cancels it. Several
 * rows can therefore be on air at once, aimed at different displays.
 * ------------------------------------------------------------------------- */
export function alertRowExpiresAt(row: { executed_at: string | null; duration_seconds: number }): number {
  if (!row.executed_at) return 0;
  return new Date(row.executed_at).getTime() + row.duration_seconds * 1000;
}

export function isAlertRowLive(
  row: { execution_status: string; executed_at: string | null; duration_seconds: number },
  now: number
): boolean {
  if (row.execution_status !== 'EXECUTED' || !row.executed_at) return false;
  return alertRowExpiresAt(row) > now;
}

export function alertRowRemaining(
  row: { executed_at: string | null; duration_seconds: number },
  now: number
): number {
  return Math.max(0, Math.ceil((alertRowExpiresAt(row) - now) / 1000));
}

/**
 * Countdown shown inside a live broadcast. Alerts are no longer capped at ten
 * minutes, so anything an hour or longer needs the hours field — MM:SS would
 * render a three hour notice as "180:00".
 */
export function formatAlertCountdown(seconds: number): string {
  return seconds >= 3600 ? formatTime(seconds) : formatShortTime(seconds);
}

/** Compact human duration for tables and summaries: "45s", "15m", "1h 30m". */
export function formatDurationLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return safe + 's';
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (!hours) return minutes + 'm';
  return minutes ? hours + 'h ' + minutes + 'm' : hours + 'h';
}

/** Duration units offered in the console, largest-first for display. */
export const DURATION_UNITS = [
  { key: 'h', label: 'hours', seconds: 3600 },
  { key: 'm', label: 'minutes', seconds: 60 },
  { key: 's', label: 'seconds', seconds: 1 },
] as const;

export type DurationUnit = typeof DURATION_UNITS[number]['key'];

/** Picks the largest unit that divides a duration evenly, for round-tripping. */
export function splitDuration(seconds: number): { value: number; unit: DurationUnit } {
  const safe = Math.max(1, Math.floor(seconds));
  for (const unit of DURATION_UNITS) {
    if (safe % unit.seconds === 0) return { value: safe / unit.seconds, unit: unit.key };
  }
  return { value: safe, unit: 's' };
}

export function durationToSeconds(value: number, unit: DurationUnit): number {
  const factor = DURATION_UNITS.find((u) => u.key === unit)?.seconds ?? 1;
  return Math.max(1, Math.round(value * factor));
}

export function calcRemaining(state: EventControlState, now: number): number {
  if (state.timer_status === 'RUNNING' && state.ends_at) {
    return Math.max(0, Math.ceil((new Date(state.ends_at).getTime() - now) / 1000));
  }
  return state.remaining_seconds;
}

export function calcAlertRemaining(alert: ActiveAlert | null, now: number): number {
  if (!alert) return 0;
  return Math.max(0, Math.ceil((alert.expiresAt - now) / 1000));
}

export function getTimerUrgency(remaining: number): string {
  if (remaining <= 0) return 'critical';
  if (remaining <= 300) return 'critical';
  if (remaining <= 600) return 'urgent';
  if (remaining <= 1800) return 'warning';
  return 'normal';
}
