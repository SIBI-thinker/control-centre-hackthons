'use client';

import { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, Radio, RotateCcw, Send, Square, Trash2, Volume2 } from 'lucide-react';
import { api } from '@/lib/api';
import { MAX_RECORDING_SECONDS, sendClip, useRecorder, type useLiveBroadcast } from '@/lib/audio-client';
import {
  ALL_DISPLAYS_TARGET,
  batchTarget,
  describeTarget,
  formatShortTime,
  isTargetedAt,
  nodeTarget,
  roomTarget,
  type EventBatch,
  type EventDisplay,
} from '@/lib/supabase';

type HistoryItem = {
  id: string;
  kind: 'clip' | 'live';
  title: string;
  target: string;
  duration_seconds: number | null;
  status: string;
  created_by: string | null;
  created_at: string;
  on_air: boolean;
};

function Meter({ level }: { level: number }) {
  const bars = 16;
  const lit = Math.round(level * bars);
  return (
    <div className="audio-meter" aria-label="Microphone level">
      {Array.from({ length: bars }).map((_, i) => (
        <i key={i} className={i < lit ? (i > bars * 0.8 ? 'hot' : 'on') : ''} />
      ))}
    </div>
  );
}

function TargetSelect({
  value,
  onChange,
  rooms,
  batches,
  displays,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  rooms: { id: string; code: string; name: string }[];
  batches: EventBatch[];
  displays: EventDisplay[];
  disabled?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value={ALL_DISPLAYS_TARGET}>{ALL_DISPLAYS_TARGET}</option>
      {rooms.length > 0 && (
        <optgroup label="Rooms">
          {rooms.map((r) => <option key={r.id} value={roomTarget(r.id)}>ROOM: {r.code} — {r.name}</option>)}
        </optgroup>
      )}
      <optgroup label="Batches">
        {batches.map((b) => <option key={b.id} value={batchTarget(b.name)}>BATCH: {b.name}</option>)}
      </optgroup>
      <optgroup label="Individual devices">
        {displays.map((d) => <option key={d.id} value={nodeTarget(d.display_id)}>{d.display_id} — {d.display_name}</option>)}
      </optgroup>
    </select>
  );
}

export function AudioPanel({
  live,
  rooms,
  roomNames,
  batches,
  displays,
  now,
}: {
  live: ReturnType<typeof useLiveBroadcast>;
  rooms: { id: string; code: string; name: string }[];
  roomNames: Record<string, string>;
  batches: EventBatch[];
  displays: EventDisplay[];
  now: number;
}) {
  const [mode, setMode] = useState<'clip' | 'live'>(live.sessionId ? 'live' : 'clip');
  const [target, setTarget] = useState(ALL_DISPLAYS_TARGET);
  const [title, setTitle] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const recorder = useRecorder();

  useEffect(() => {
    if (live.sessionId) setMode('live');
  }, [live.sessionId]);

  const loadHistory = async () => {
    const { data } = await api<{ broadcasts: HistoryItem[] }>('GET', '/api/admin/audio');
    if (data) setHistory(data.broadcasts);
  };

  useEffect(() => {
    loadHistory();
    const interval = setInterval(loadHistory, 5000);
    return () => clearInterval(interval);
  }, []);

  const reach = useMemo(() => {
    const matched = displays.filter((d) => d.enabled && isTargetedAt(target, d));
    const online = matched.filter((d) => d.last_heartbeat_at && now - new Date(d.last_heartbeat_at).getTime() < 35000);
    return { matched: matched.length, online: online.length };
  }, [displays, target, now]);

  const handleSendClip = async () => {
    if (!recorder.result) return;
    if (!confirm('Play “' + title + '” on ' + reach.online + ' online display(s) now?')) return;
    setSending(true);
    const { data, error } = await sendClip(recorder.result, title, target);
    setSending(false);
    if (error) {
      setFeedback({ ok: false, text: error.message });
      return;
    }
    setFeedback({ ok: true, text: 'Sent — playing on ' + (data ? data.reached : 0) + ' online display(s).' });
    recorder.discard();
    setTitle('');
    loadHistory();
  };

  const handleGoLive = async () => {
    setFeedback(null);
    const ok = await live.start(title, target);
    if (ok) loadHistory();
  };

  const connected = live.peers.filter((p) => p.state === 'connected').length;
  const failed = live.peers.filter((p) => p.state === 'failed');

  return (
    <div className="view-container">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">AUDIO BROADCAST</span>
          <p>Speak to the venue through the display screens. A recorded clip is the most reliable; live mic is instant but needs a direct network path to each screen.</p>
        </div>
      </div>

      <div className="segmented">
        <button className={mode === 'clip' ? 'active' : ''} onClick={() => setMode('clip')} disabled={Boolean(live.sessionId)}>
          <Mic size={13} /> Record clip
        </button>
        <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>
          <Radio size={13} /> Live mic {live.sessionId && <b className="nav-badge-urgent">ON AIR</b>}
        </button>
      </div>

      <section className="cyber-frame">
        <div className="inline-form" style={{ marginBottom: 14 }}>
          <label className="field field-wide">
            <span>Title (shown on screens while it plays)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Lunch is served" disabled={Boolean(live.sessionId)} />
          </label>
          <label className="field field-wide">
            <span>Play on</span>
            <TargetSelect value={target} onChange={setTarget} rooms={rooms} batches={batches} displays={displays} disabled={Boolean(live.sessionId)} />
          </label>
        </div>
        <p className="panel-hint" style={{ marginTop: 0 }}>
          {describeTarget(target, roomNames)} — {reach.online} of {reach.matched} screen{reach.matched === 1 ? '' : 's'} online now.
          {reach.online === 0 && ' Nobody will hear it.'}
        </p>

        {mode === 'clip' && (
          <div className="audio-recorder">
            {!recorder.result ? (
              <>
                <button
                  className={recorder.recording ? 'record-button recording' : 'record-button'}
                  onClick={recorder.recording ? recorder.stop : recorder.start}
                  aria-label={recorder.recording ? 'Stop recording' : 'Start recording'}
                >
                  {recorder.recording ? <Square size={26} /> : <Mic size={28} />}
                </button>
                <div className="audio-recorder-status">
                  <strong>{recorder.recording ? formatShortTime(Math.floor(recorder.elapsed)) : 'Tap to record'}</strong>
                  <span>
                    {recorder.recording
                      ? 'Recording — tap again to stop (max ' + MAX_RECORDING_SECONDS / 60 + ' min)'
                      : 'Your browser will ask for microphone access the first time.'}
                  </span>
                  {recorder.recording && <Meter level={recorder.level} />}
                </div>
              </>
            ) : (
              <div className="audio-preview">
                <span className="eyebrow">PREVIEW · {formatShortTime(Math.round(recorder.result.seconds))}</span>
                <audio controls src={recorder.result.url} />
                <div className="row-actions">
                  <button className="outline-action" onClick={recorder.discard}>
                    <Trash2 size={14} /> Discard
                  </button>
                  <button className="outline-action" onClick={recorder.start}>
                    <RotateCcw size={14} /> Re-record
                  </button>
                  <button className="primary-action" onClick={handleSendClip} disabled={sending || !title.trim()}>
                    <Send size={14} /> {sending ? 'Uploading…' : 'Play on screens'}
                  </button>
                </div>
                {!title.trim() && <span className="panel-hint">Add a title before sending.</span>}
              </div>
            )}
            {recorder.error && <div className="action-error"><span>{recorder.error}</span></div>}
          </div>
        )}

        {mode === 'live' && !live.sessionId && (
          <div className="audio-live-idle">
            <button className="primary-action live-go" onClick={handleGoLive} disabled={live.starting || !title.trim() || reach.online === 0}>
              <Radio size={16} /> {live.starting ? 'Connecting…' : 'Go live'}
            </button>
            <p className="panel-hint">
              Screens connect directly to this browser. On guest Wi-Fi that isolates devices, some may fail to connect — the
              panel will show which, and a recorded clip will still reach them.
            </p>
          </div>
        )}

        {mode === 'live' && live.sessionId && (
          <div className="audio-live-on">
            <div className="on-air-banner">
              <span className="on-air-dot" />
              <strong>ON AIR · {live.title}</strong>
              <span className="mono">{formatShortTime(Math.floor((now - live.startedAt) / 1000))}</span>
              <Meter level={live.level} />
            </div>
            <div className="row-actions" style={{ margin: '12px 0' }}>
              <button className="outline-action" onClick={live.toggleMute}>
                {live.muted ? <MicOff size={14} /> : <Mic size={14} />} {live.muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="primary-action" onClick={live.stop}>
                <Square size={14} /> End broadcast
              </button>
            </div>
            <div className="peer-grid">
              {live.peers.map((p) => (
                <span key={p.display_uuid} className={'peer-chip ' + p.state}>
                  {p.display_id} · {p.state === 'connected' ? 'hearing you' : p.state === 'failed' ? 'failed' : 'connecting'}
                </span>
              ))}
            </div>
            <p className="panel-hint">
              {connected} of {live.peers.length} screen{live.peers.length === 1 ? '' : 's'} connected. Keep this browser open —
              closing it or losing your session ends the broadcast.
            </p>
            {failed.length > 0 && (
              <div className="issue-urgent-note">
                {failed.length} screen{failed.length === 1 ? '' : 's'} ({failed.map((f) => f.display_id).join(', ')}) couldn&apos;t
                connect directly. End the broadcast and send a recorded clip to reach them, or add a TURN relay on the server.
              </div>
            )}
          </div>
        )}

        {live.error && (
          <div className="action-error">
            <span>{live.error}</span>
            <button onClick={live.clearError} aria-label="Dismiss">×</button>
          </div>
        )}
        {feedback && <div className={feedback.ok ? 'import-summary good' : 'action-error'}><span>{feedback.text}</span></div>}
      </section>

      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">RECENT</span>
            <h2>Audio history</h2>
          </div>
          <Volume2 size={20} />
        </div>
        <div className="cyber-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th>TYPE</th>
                <th>TITLE</th>
                <th>TARGET</th>
                <th>LENGTH</th>
                <th>BY</th>
                <th>SENT</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.kind === 'live' ? 'LIVE' : 'CLIP'}</td>
                  <td><strong style={{ color: 'var(--white)' }}>{h.title}</strong></td>
                  <td>{describeTarget(h.target, roomNames)}</td>
                  <td>{h.duration_seconds ? formatShortTime(Math.round(Number(h.duration_seconds))) : '—'}</td>
                  <td>{h.created_by}</td>
                  <td>{new Date(h.created_at).toLocaleTimeString('en-IN', { hour12: false })}</td>
                  <td>
                    <span className="row-actions">
                      {h.on_air && (h.kind === 'clip' || h.id !== live.sessionId) && (
                        <button
                          className="inline-dismiss"
                          onClick={async () => {
                            await api('POST', '/api/admin/audio/' + h.id + '/stop');
                            loadHistory();
                          }}
                        >
                          <Square size={11} /> Stop
                        </button>
                      )}
                      {h.kind === 'clip' && !h.on_air && (
                        <button
                          className="inline-dismiss"
                          onClick={async () => {
                            if (!confirm('Play “' + h.title + '” again to ' + describeTarget(h.target, roomNames) + '?')) return;
                            const { data, error } = await api<{ reached: number }>('POST', '/api/admin/audio/' + h.id + '/replay', {});
                            setFeedback(error ? { ok: false, text: error.message } : { ok: true, text: 'Replaying on ' + (data ? data.reached : 0) + ' online display(s).' });
                            loadHistory();
                          }}
                        >
                          <RotateCcw size={11} /> Replay
                        </button>
                      )}
                      {h.on_air && <span className="phase-status live">ON AIR</span>}
                    </span>
                  </td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={7} className="empty-cell">No audio broadcasts yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <p className="panel-hint">
        Screens only play sound after someone taps them once — do a sound check on every display after it starts. For
        unattended kiosks, launch Chrome with <code>--autoplay-policy=no-user-gesture-required</code>.
      </p>
    </div>
  );
}
