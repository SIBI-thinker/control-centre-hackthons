'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { AccountSummary, IssuedCredential, Role, Room, Team } from '@/lib/supabase';

/**
 * Fetches a server-only resource through the API and keeps it fresh by
 * polling. These tables are invisible to the anon key, so there's no realtime
 * subscription to lean on.
 */
export function useApiResource<T>(path: string | null, pick: (data: any) => T, fallback: T, intervalMs: number = 15000) {
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const refetch = useCallback(async () => {
    if (!path) return;
    const result = await api('GET', path);
    if (result.data) {
      setData(pickRef.current(result.data));
      setError(null);
    } else if (result.error) {
      setError(result.error.message);
    }
    setLoading(false);
  }, [path]);

  useEffect(() => {
    refetch();
    if (!path) return;
    const interval = setInterval(refetch, intervalMs);
    return () => clearInterval(interval);
  }, [refetch, path, intervalMs]);

  return { data, loading, error, refetch };
}

// ------------------------------------------------------------------ rooms
export type RoomWithCounts = Room & { display_count: number; team_count: number; operator_count: number };

export function useRooms() {
  const { data, ...rest } = useApiResource<RoomWithCounts[]>('/api/admin/rooms', (d) => d.rooms, []);
  return { rooms: data, ...rest };
}

export function createRooms(rooms: { code: string; name: string; location?: string }[]) {
  return api<{ rooms: Room[] }>('POST', '/api/admin/rooms', { rooms });
}

export function updateRoom(id: string, updates: { code?: string; name?: string; location?: string | null }) {
  return api('PATCH', '/api/admin/rooms/' + id, updates);
}

export function deleteRoom(id: string) {
  return api('DELETE', '/api/admin/rooms/' + id);
}

export function assignDisplayRoom(displayUuid: string, roomId: string | null) {
  return api('PATCH', '/api/admin/displays/' + displayUuid, { room_id: roomId });
}

// ------------------------------------------------------------------ teams
export type TeamWithCount = Team & { member_count: number };

export function useTeams() {
  const { data, ...rest } = useApiResource<TeamWithCount[]>('/api/admin/teams', (d) => d.teams, []);
  return { teams: data, ...rest };
}

export function createTeam(team: { name: string; room_id: string | null; code?: string }) {
  return api<{ team: Team }>('POST', '/api/admin/teams', team);
}

export function updateTeam(id: string, updates: { name?: string; code?: string; room_id?: string | null }) {
  return api('PATCH', '/api/admin/teams/' + id, updates);
}

export function deleteTeam(id: string) {
  return api('DELETE', '/api/admin/teams/' + id);
}

export function resetTeamPins(id: string) {
  return api<{ credentials: IssuedCredential[] }>('POST', '/api/admin/teams/' + id + '/reset-pins');
}

// ------------------------------------------------------------------ accounts
export function useAccounts() {
  const { data, ...rest } = useApiResource<AccountSummary[]>('/api/admin/accounts', (d) => d.accounts, []);
  return { accounts: data, ...rest };
}

export function createAccount(input: {
  role: Role;
  display_name: string;
  account_id?: string;
  team_id?: string;
  room_ids?: string[];
  pin?: string;
}) {
  return api<{ credential: IssuedCredential }>('POST', '/api/admin/accounts', input);
}

export function updateAccount(id: string, updates: { display_name?: string; active?: boolean; team_id?: string; room_ids?: string[] }) {
  return api('PATCH', '/api/admin/accounts/' + id, updates);
}

export function deleteAccount(id: string) {
  return api('DELETE', '/api/admin/accounts/' + id);
}

export function resetAccountPin(id: string) {
  return api<{ credential: IssuedCredential }>('POST', '/api/admin/accounts/' + id + '/reset-pin');
}

export type ImportPreviewRow = {
  line: number;
  account_id: string | null;
  name: string;
  team?: string;
  /** The team code the row pinned itself to, if it used one. */
  team_id?: string;
  room?: string;
  rooms?: string[];
  new_team?: boolean;
  error?: string;
};

export type ImportResult = {
  preview: ImportPreviewRow[];
  summary: { rows: number; errors: number; generated_ids: number; new_teams?: string[] };
  committed: boolean;
  credentials?: IssuedCredential[];
};

export function importAccounts(kind: 'participants' | 'operators', csv: string, commit: boolean) {
  return api<ImportResult>('POST', '/api/admin/accounts/import', { kind, csv, commit });
}

// ------------------------------------------------------------------ phases
export type PhaseItem = { id: string; label: string; position: number };
export type PhaseTeamProgress = { team_id: string; name: string; code: string; room_id: string; done: number };
export type AdminPhaseFieldOption = { id: string; label: string; body: string };
export type AdminPhaseField = {
  id: string;
  kind: 'text' | 'choice';
  label: string;
  help: string;
  required: boolean;
  max_length: number;
  options: AdminPhaseFieldOption[];
};

export type AdminPhase = {
  id: string;
  title: string;
  requirements: string;
  starts_at: string;
  ends_at: string;
  created_by: string | null;
  room_ids: string[];
  items: PhaseItem[];
  fields: AdminPhaseField[];
  team_progress: PhaseTeamProgress[];
};

export function usePhases() {
  const { data, ...rest } = useApiResource<AdminPhase[]>('/api/admin/phases', (d) => d.phases, [], 20000);
  return { phases: data, ...rest };
}

export function savePhase(phase: {
  id?: string;
  title: string;
  requirements: string;
  starts_at: string;
  ends_at: string;
  room_ids: string[];
  items: { id?: string; label: string }[];
  fields?: {
    id?: string;
    kind: 'text' | 'choice';
    label: string;
    help: string;
    required: boolean;
    max_length: number;
    options: { id?: string; label: string; body: string }[];
  }[];
}) {
  return api<{ id: string }>('POST', '/api/admin/phases', phase);
}

export function deletePhase(id: string) {
  return api('DELETE', '/api/admin/phases/' + id);
}

// ------------------------------------------------------------------ wi-fi
export type WifiSettings = {
  ssid: string | null;
  ssid_password: string | null;
  instructions: string | null;
  default_username: string | null;
  default_password: string | null;
};
export type WifiCredential = {
  id: string;
  username: string;
  password: string;
  label: string | null;
  assigned_team_id: string | null;
  assigned_account_id: string | null;
  assigned_to: { kind: 'team' | 'participant'; id: string; label: string } | null;
};
export type WifiOverview = {
  settings: WifiSettings;
  credentials: WifiCredential[];
  teams: { id: string; name: string; code: string; has_wifi: boolean }[];
  participants: { id: string; account_id: string; display_name: string; team_id: string | null; has_wifi: boolean }[];
  stats: { total: number; unassigned: number; teams_without: number; participants_without: number };
};

const EMPTY_WIFI: WifiOverview = {
  settings: { ssid: null, ssid_password: null, instructions: null, default_username: null, default_password: null },
  credentials: [],
  teams: [],
  participants: [],
  stats: { total: 0, unassigned: 0, teams_without: 0, participants_without: 0 },
};

export function useWifi() {
  const { data, ...rest } = useApiResource<WifiOverview>('/api/admin/wifi', (d) => d as WifiOverview, EMPTY_WIFI, 20000);
  return { wifi: data, ...rest };
}

export function saveWifiSettings(updates: Partial<WifiSettings>) {
  return api('PATCH', '/api/admin/wifi/settings', updates);
}

export function addWifiCredential(input: { username: string; password: string; label?: string; assigned_team_id?: string | null; assigned_account_id?: string | null }) {
  return api<{ id: string }>('POST', '/api/admin/wifi', input);
}

export function updateWifiCredential(id: string, updates: Record<string, unknown>) {
  return api('PATCH', '/api/admin/wifi/' + id, updates);
}

export function deleteWifiCredential(id: string) {
  return api('DELETE', '/api/admin/wifi/' + id);
}

export function allotWifi(mode: 'teams' | 'participants') {
  return api<{ allotted: number; shortfall: number }>('POST', '/api/admin/wifi/allot', { mode });
}

export type WifiImportResult = {
  logins: { username: string; password: string; label?: string; team?: string; account_id?: string; line: number; conflict?: boolean }[];
  skipped: { line: number; text: string }[];
  duplicates: string[];
  conflicts: string[];
  unknown: string[];
  /** Team names that match more than one team — the file must give a code. */
  ambiguous?: string[];
  committed: boolean;
  imported?: number;
  source?: string;
  extracted_text?: string;
};

export function importWifiText(text: string, commit: boolean) {
  return api<WifiImportResult>('POST', '/api/admin/wifi/import', { text, commit });
}

/** CSV or PDF upload; the server pulls the text out of a PDF. */
export async function importWifiFile(file: File, commit: boolean) {
  const form = new FormData();
  form.append('file', file);
  form.append('commit', String(commit));
  try {
    const res = await fetch('/api/admin/wifi/import', { method: 'POST', body: form, credentials: 'same-origin' });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) window.location.href = '/login?reason=expired';
    if (!res.ok) return { data: null, error: { message: payload.error || 'Import failed.', status: res.status } };
    return { data: payload as WifiImportResult, error: null };
  } catch {
    return { data: null, error: { message: 'Network error — nothing was imported.', status: 0 } };
  }
}
