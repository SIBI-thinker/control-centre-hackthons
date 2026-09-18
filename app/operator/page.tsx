'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DoorOpen, Megaphone, MonitorSmartphone, Send, Users, X } from 'lucide-react';
import { PortalShell } from '@/components/portal/portal-shell';
import { IssueBoard } from '@/components/issues/issue-board';
import { api } from '@/lib/api';
import { useEventState } from '@/lib/hooks';
import { useIssueAlerts, useIssues } from '@/lib/issues-api';
import {
  DURATION_UNITS,
  durationToSeconds,
  formatAlertCountdown,
  formatDurationLabel,
  formatTime,
  roomTarget,
  type DurationUnit,
} from '@/lib/supabase';

type RoomOverview = {
  id: string;
  code: string;
  name: string;
  location: string | null;
  displays: { id: string; display_id: string; display_name: string; enabled: boolean; online: boolean }[];
  teams: { id: string; name: string; code: string; wifi_username: string | null; wifi_password: string | null }[];
  current_phase: { title: string; starts_at: string; ends_at: string } | null;
  next_phase: { title: string; starts_at: string } | null;
};

type RoomAlert = {
  id: string;
  title: string;
  message: string;
  message_type: string;
  duration_seconds: number;
  target: string;
  execution_status: string;
  executed_at: string | null;
  created_by: string | null;
};

const TYPES = ['INFO', 'ANNOUNCEMENT', 'WARNING', 'ALERT', 'URGENT', 'SUCCESS'];

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function OperatorPage() {
  const { remaining, state, now } = useEventState(10000);
  const [rooms, setRooms] = useState<RoomOverview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [alerts, setAlerts] = useState<RoomAlert[]>([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'rooms' | 'issues'>('rooms');

  const { issues, loaded: issuesLoaded, refetch: refetchIssues } = useIssues();
  const [soundOn, setSoundOn] = useState(true);
  const { unacknowledgedUrgent, latest, dismissLatest } = useIssueAlerts(issues, issuesLoaded, soundOn);

  const loadRooms = useCallback(async () => {
    const { data, error: apiError } = await api<{ rooms: RoomOverview[] }>('GET', '/api/operator/overview');
    if (data) setRooms(data.rooms);
    if (apiError) setError(apiError.message);
    setLoaded(true);
  }, []);

  const loadAlerts = useCallback(async () => {
    const { data } = await api<{ alerts: RoomAlert[] }>('GET', '/api/operator/alerts');
    if (data) setAlerts(data.alerts);
  }, []);

  useEffect(() => {
    loadRooms();
    loadAlerts();
    const a = setInterval(loadRooms, 15000);
    const b = setInterval(loadAlerts, 8000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [loadRooms, loadAlerts]);

  const roomById = useMemo(() => {
    const map: Record<string, RoomOverview> = {};
    rooms.forEach((r) => (map[r.id] = r));
    return map;
  }, [rooms]);

  const liveAlerts = alerts.filter(
    (a) => a.execution_status === 'EXECUTED' && a.executed_at && new Date(a.executed_at).getTime() + a.duration_seconds * 1000 > now
  );

  const activeIssues = issues.filter((i) => i.status !== 'resolved').length;

  return (
    <PortalShell roleLabel="ROOM OPERATOR" subtitle={rooms.map((r) => r.code).join(', ') || null}>
      {error && <div className="action-error"><span>{error}</span></div>}

      {unacknowledgedUrgent.length > 0 && (
        <button className="urgent-issue-banner" onClick={() => setTab('issues')}>
          <strong>{unacknowledgedUrgent.length} urgent issue{unacknowledgedUrgent.length === 1 ? '' : 's'} in your rooms</strong>
          <span>{unacknowledgedUrgent[0].title}{unacknowledgedUrgent[0].room_code ? ' · ' + unacknowledgedUrgent[0].room_code : ''}</span>
        </button>
      )}
      {latest && latest.priority !== 'urgent' && tab !== 'issues' && (
        <div className="new-issue-toast">
          <span>New issue: <strong>{latest.title}</strong>{latest.room_code ? ' · ' + latest.room_code : ''}</span>
          <button className="inline-dismiss" onClick={() => { setTab('issues'); dismissLatest(); }}>View</button>
          <button className="icon-danger" onClick={dismissLatest} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <div className="operator-timer">
        <span className="eyebrow">EVENT TIME REMAINING</span>
        <strong>{state ? formatTime(remaining) : '--:--:--'}</strong>
      </div>

      <div className="segmented">
        <button className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}>My rooms <b>{rooms.length}</b></button>
        <button className={tab === 'issues' ? 'active' : ''} onClick={() => setTab('issues')}>Issues <b className={unacknowledgedUrgent.length ? 'nav-badge-urgent' : ''}>{activeIssues}</b></button>
      </div>

      {tab === 'rooms' && (
        <>
          {loaded && rooms.length === 0 && (
            <section className="cyber-frame">
              <p className="panel-hint" style={{ margin: 0 }}>You haven&apos;t been assigned to any rooms yet. Ask the core team.</p>
            </section>
          )}

          <div className="operator-rooms">
            {rooms.map((room) => {
              const online = room.displays.filter((d) => d.online).length;
              return (
                <section key={room.id} className="cyber-frame operator-room">
                  <div className="panel-heading" style={{ marginBottom: 10 }}>
                    <div>
                      <span className="eyebrow">{room.location || 'ROOM'}</span>
                      <h2>{room.code} · {room.name}</h2>
                    </div>
                    <DoorOpen size={20} />
                  </div>
                  <div className="operator-room-stats">
                    <span className={online < room.displays.length ? 'warn' : ''}>
                      <MonitorSmartphone size={13} /> {online}/{room.displays.length} displays online
                    </span>
                    <span><Users size={13} /> {room.teams.length} team{room.teams.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="operator-room-phase">
                    {room.current_phase ? (
                      <>Now: <strong>{room.current_phase.title}</strong> until {clock(room.current_phase.ends_at)}</>
                    ) : room.next_phase ? (
                      <>No phase now · next <strong>{room.next_phase.title}</strong> at {clock(room.next_phase.starts_at)}</>
                    ) : (
                      <>No phase scheduled</>
                    )}
                  </div>
                  {room.displays.some((d) => !d.online) && (
                    <p className="panel-hint">Offline: {room.displays.filter((d) => !d.online).map((d) => d.display_id).join(', ')}</p>
                  )}
                  {room.teams.length > 0 && (
                    <details className="operator-wifi">
                      <summary>Team Wi-Fi logins ({room.teams.filter((t) => t.wifi_username).length}/{room.teams.length})</summary>
                      <ul>
                        {room.teams.map((t) => (
                          <li key={t.id}>
                            <span>{t.name}</span>
                            {t.wifi_username ? (
                              <code>{t.wifi_username} / {t.wifi_password}</code>
                            ) : (
                              <em>no login yet</em>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              );
            })}
          </div>

          {rooms.length > 0 && (
            <RoomAlertComposer rooms={rooms} onSent={loadAlerts} />
          )}

          {liveAlerts.length > 0 && (
            <section className="cyber-frame">
              <span className="eyebrow">ON AIR IN YOUR ROOMS</span>
              <div className="live-alert-stack" style={{ marginTop: 10, marginBottom: 0 }}>
                {liveAlerts.map((a) => {
                  const roomId = a.target.slice('ROOM:'.length);
                  const left = Math.max(0, Math.ceil((new Date(a.executed_at!).getTime() + a.duration_seconds * 1000 - now) / 1000));
                  return (
                    <div key={a.id} className="alert-preview live-alert-row">
                      <div className="preview-icon"><Megaphone size={18} /></div>
                      <div>
                        <span style={{ color: 'var(--red-bright)' }}>
                          {a.message_type} // {roomById[roomId]?.code || 'room'} ({formatAlertCountdown(left)} left) · sent by {a.created_by}
                        </span>
                        <strong style={{ fontSize: 15 }}>{a.title}</strong>
                        <p>{a.message}</p>
                      </div>
                      <button
                        style={{ width: 'auto', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
                        onClick={async () => {
                          const { error: apiError } = await api('POST', '/api/operator/alerts/dismiss', { id: a.id });
                          setError(apiError ? apiError.message : '');
                          loadAlerts();
                        }}
                      >
                        <X size={14} /> Dismiss
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}

      {tab === 'issues' && (
        <IssueBoard
          issues={issues}
          refetch={refetchIssues}
          rooms={rooms}
          canRaiseWithoutRoom={false}
          soundOn={soundOn}
          onToggleSound={() => setSoundOn(!soundOn)}
          now={now}
        />
      )}
    </PortalShell>
  );
}

function RoomAlertComposer({ rooms, onSent }: { rooms: RoomOverview[]; onSent: () => void }) {
  const [roomId, setRoomId] = useState(rooms[0].id);
  const [type, setType] = useState('ANNOUNCEMENT');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [value, setValue] = useState(2);
  const [unit, setUnit] = useState<DurationUnit>('m');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!rooms.some((r) => r.id === roomId)) setRoomId(rooms[0].id);
  }, [rooms, roomId]);

  const seconds = durationToSeconds(value, unit);
  const tooLong = seconds > 3600;
  const room = rooms.find((r) => r.id === roomId);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirm('Broadcast “' + title + '” on every display in ' + (room ? room.code : 'this room') + '?')) return;
    setSending(true);
    const { error } = await api('POST', '/api/operator/alerts', {
      title,
      message,
      type,
      animation: type === 'URGENT' || type === 'ALERT' ? 'WARNING' : 'SLIDE',
      duration: seconds,
      target: roomTarget(roomId),
    });
    setSending(false);
    if (error) {
      setFeedback({ ok: false, text: error.message });
      return;
    }
    setFeedback({ ok: true, text: 'Sent to ' + (room ? room.code : 'room') + ' for ' + formatDurationLabel(seconds) + '.' });
    setTitle('');
    setMessage('');
    onSent();
  };

  return (
    <section className="cyber-frame">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ROOM BROADCAST</span>
          <h2>Send an alert to a room&apos;s displays</h2>
        </div>
        <Megaphone size={20} />
      </div>
      <form onSubmit={send} className="operator-alert-form">
        <div className="inline-form">
          <label className="field">
            <span>Room</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name} ({r.displays.length} displays)</option>)}
            </select>
          </label>
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Show for</span>
            <span className="duration-field">
              <input type="number" min={1} value={value} onChange={(e) => setValue(Math.max(1, Number(e.target.value)))} />
              <select value={unit} onChange={(e) => setUnit(e.target.value as DurationUnit)}>
                {DURATION_UNITS.filter((u) => u.key !== 'h').map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </select>
            </span>
          </label>
        </div>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Mentor visiting in 5 minutes" required />
        </label>
        <label className="field">
          <span>Message</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={3} required />
        </label>
        {tooLong && <p className="issue-urgent-note">Room alerts from operators can last at most 1 hour.</p>}
        {feedback && <div className={feedback.ok ? 'import-summary good' : 'action-error'}><span>{feedback.text}</span></div>}
        <button type="submit" className="primary-action" disabled={sending || tooLong || !title.trim() || !message.trim()}>
          <Send size={15} /> {sending ? 'Sending…' : 'Broadcast to ' + (room ? room.code : 'room')}
        </button>
        {room && room.displays.length === 0 && <p className="panel-hint">No displays are assigned to {room.code}, so nothing will show.</p>}
      </form>
    </section>
  );
}
