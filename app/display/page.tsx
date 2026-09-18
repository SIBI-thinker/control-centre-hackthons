'use client';

import { useEffect, useRef, useState } from 'react';
import { Activity, Bluetooth, Cpu, Fullscreen, Link2, Loader2, Mic, MonitorCog, Radio, ShieldCheck, Volume2, VolumeX, Wifi, X, Zap } from 'lucide-react';
import { useBrand, useDisplayAlert, useDisplayDevice, useEventState, useScheduledAlertTrigger } from '@/lib/hooks';
import { BrandLockup } from '@/components/brand-lockup';
import { useDisplayAudio } from '@/lib/audio-client';
import { calcAlertRemaining, describeTarget, formatAlertCountdown, formatTime, getTimerUrgency } from '@/lib/supabase';
import type { ActiveAlert } from '@/lib/supabase';

function playChime(type: string = 'ALERT') {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const isHighAlert = type === 'URGENT' || type === 'ALERT' || type === 'WARNING';
    osc.type = isHighAlert ? 'triangle' : 'sine';

    const now = ctx.currentTime;
    if (isHighAlert) {
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.25);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.7);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.7);
    } else {
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.15);
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.3);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.6);
    }
  } catch {
    // Autoplay policy fallback
  }
}

function RobotVisual({ warning }: { warning: boolean }) {
  return (
    <div className={`robot-visual ${warning ? 'robot-warning' : ''}`} aria-label={warning ? 'Robot warning status' : 'Robot active status'}>
      <div className="robot-ring ring-one" />
      <div className="robot-ring ring-two" />
      <div className="robot-head">
        <div className="robot-antenna"><i /><span /></div>
        <div className="robot-ear left" />
        <div className="robot-ear right" />
        <div className="robot-face">
          <div className="robot-brow" />
          <div className="robot-eyes"><i /><i /></div>
          <div className="robot-mouth"><span /><span /><span /></div>
        </div>
        <div className="robot-neck" />
      </div>
      <div className="robot-base"><span /><span /><span /></div>
      <div className="robot-label">
        <span className="robot-live-dot" /> ROBOT STATUS: {warning ? 'WARNING' : 'ACTIVE'}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = status === 'RUNNING' ? 'HACKATHON LIVE' : status === 'PAUSED' ? 'SYSTEM PAUSED' : status === 'ENDED' ? 'HACKATHON COMPLETE' : 'SYSTEM STANDBY';
  return <span className={`status-pill ${status.toLowerCase()}`}><span className="status-dot" />{label}</span>;
}

/**
 * Pairing screen. A kiosk can no longer pick or register a display itself —
 * that let anyone who opened /display create fake screens and spoof
 * heartbeats. An admin generates a one-time code in the control center
 * (Displays → Pair) and it is entered here.
 */
function PairingScreen({
  notice,
  onPair,
}: {
  notice: string | null;
  onPair: (code: string) => Promise<{ error: { message: string } | null }>;
}) {
  const brand = useBrand();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);

  const cleaned = code.replace(/[\s-]/g, '').toUpperCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cleaned.length !== 6) {
      setError('Pairing codes are 6 characters.');
      return;
    }
    setPairing(true);
    setError('');
    const { error: pairError } = await onPair(cleaned);
    setPairing(false);
    if (pairError) setError(pairError.message);
  };

  return (
    <main className="display-shell node-setup-shell">
      <div className="display-grid" />
      <div className="display-scanlines" />

      <form className="node-setup" onSubmit={handleSubmit}>
        <header className="node-setup-head">
          <BrandLockup brand={brand} subtitle="DISPLAY NODE PAIRING" />
        </header>

        <p className="node-setup-lead">
          In the control center, open <b>Displays</b>, choose the screen this device should be, and press{' '}
          <b>Pair</b>. Enter the 6-character code it shows. Codes work once and expire after 15 minutes.
        </p>

        {notice && <div className="node-setup-notice">{notice}</div>}

        <label className="pairing-input-label">
          Pairing code
          <input
            className="pairing-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XYZ-789"
            maxLength={9}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>

        {error && <div className="node-setup-error">{error}</div>}

        <button type="submit" className="primary-action pairing-submit" disabled={pairing || cleaned.length !== 6}>
          {pairing ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />}
          {pairing ? 'Pairing…' : 'Pair this screen'}
        </button>

        <footer className="node-setup-foot">
          <span>{brand.organization.toUpperCase()}</span>
          <span className="mono">Stays paired for 30 days on this device</span>
        </footer>
      </form>
    </main>
  );
}

/**
 * Display screen.
 *
 * Identity comes from this kiosk's device token, confirmed by the server on
 * every heartbeat. With no valid token the pairing screen is shown.
 *
 * A paired screen only renders alerts addressed to it — venue-wide broadcasts,
 * its own batch, or its specific node id.
 */
export default function DisplayScreen() {
  const { state, remaining, now, loading } = useEventState();
  const brand = useBrand(state);
  const device = useDisplayDevice(state?.heartbeat_interval ?? 10);
  const display = device.display;
  const displayId = display ? display.display_id : null;

  // Displays drive scheduled-alert execution; there's no background worker.
  useScheduledAlertTrigger(device.status === 'paired');

  // Sound starts off: browsers refuse audio until someone taps the page, and
  // turning it on IS that tap.
  const [sound, setSound] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const audio = useDisplayAudio(device.status === 'paired' && Boolean(display && display.enabled), sound);
  const lastAlertIdRef = useRef<string | null>(null);

  // ---------- Alert transition state ----------
  // When a new broadcast replaces an existing one, we show a brief exit flash
  // on the old alert before the new one animates in. This prevents the old
  // HUD from snapping away and gives visual continuity.
  const [visibleAlert, setVisibleAlert] = useState<ActiveAlert | null>(null);
  const [alertTransition, setAlertTransition] = useState<'enter' | 'exit' | 'idle'>('idle');
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A node is only muted when we positively know it is disabled — if the
  // registry row hasn't resolved yet the screen still shows venue-wide
  // broadcasts rather than going silently dark.
  const nodeDisabled = Boolean(display && !display.enabled);

  // Per-display alert resolution: each display queries event_alerts independently,
  // so multiple displays can show different alerts simultaneously.
  const displayAlert = useDisplayAlert(display, displayId, now);
  const incomingAlert = nodeDisabled ? null : displayAlert;

  // Drive the transition machine:
  //   null → alert   : enter animation
  //   alertA → alertB: exit old → enter new (200ms gap)
  //   alert → null   : exit animation then idle
  useEffect(() => {
    // Clean up pending transition on unmount
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const prevId = visibleAlert?.id ?? null;
    const nextId = incomingAlert?.id ?? null;

    // Same alert or both null — nothing to do
    if (prevId === nextId) {
      // If it's an active alert, keep it updated (remaining time etc.)
      if (incomingAlert) setVisibleAlert(incomingAlert);
      return;
    }

    // Cancel any pending transition
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }

    if (prevId && nextId) {
      // REPLACEMENT: old alert exits, new one enters after a brief flash
      setAlertTransition('exit');
      transitionTimerRef.current = setTimeout(() => {
        setVisibleAlert(incomingAlert);
        setAlertTransition('enter');
        transitionTimerRef.current = null;
      }, 250); // 250ms exit flash
    } else if (!prevId && nextId) {
      // NEW alert arrives (no previous)
      setVisibleAlert(incomingAlert);
      setAlertTransition('enter');
    } else if (prevId && !nextId) {
      // Alert expired/dismissed
      setAlertTransition('exit');
      transitionTimerRef.current = setTimeout(() => {
        setVisibleAlert(null);
        setAlertTransition('idle');
        transitionTimerRef.current = null;
      }, 300); // 300ms exit animation
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingAlert?.id]);

  // Keep visibleAlert's remaining time in sync when not transitioning
  useEffect(() => {
    if (incomingAlert && visibleAlert && incomingAlert.id === visibleAlert.id) {
      setVisibleAlert(incomingAlert);
    }
  }, [incomingAlert, visibleAlert]);

  // Derived from the transition-aware visible alert
  const alert = visibleAlert;
  const alertRemaining = alert ? calcAlertRemaining(alert, now) : 0;
  const urgency = getTimerUrgency(remaining);
  const progress = state?.duration_seconds ? Math.min(100, Math.max(0, (remaining / state.duration_seconds) * 100)) : 0;
  const alertProgress = alert ? Math.min(100, Math.max(0, (alertRemaining / alert.duration) * 100)) : 0;
  const isWarning = Boolean(incomingAlert) || urgency === 'urgent' || urgency === 'critical';

  // Play chime on each new alert (including replacements)
  useEffect(() => {
    if (incomingAlert && incomingAlert.id !== lastAlertIdRef.current) {
      lastAlertIdRef.current = incomingAlert.id;
      if (sound) {
        playChime(incomingAlert.type);
      }
    }
  }, [incomingAlert, sound]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
        setFullscreen(true);
      } else {
        await document.exitFullscreen?.();
        setFullscreen(false);
      }
    } catch {
      // Fullscreen not allowed
    }
  };

  if (device.status === 'unpaired') {
    return <PairingScreen notice={device.notice} onPair={device.pair} />;
  }

  if (device.status === 'checking' || loading || !state) {
    return (
      <main className="display-shell display-loading">
        <div className="display-loader">
          <div className="brand-mark">{brand.mark}</div>
          <span>CONNECTING TO EVENT CORE</span>
          {device.problem && device.status === 'checking' && (
            <small className="display-loader-problem">{device.problem} Retrying…</small>
          )}
        </div>
      </main>
    );
  }

  const nodeName = display?.display_name || displayId;
  const nodeBatch = display?.batch || 'ALL';

  return (
    <main className={`display-shell urgency-${urgency} ${incomingAlert ? 'has-alert' : ''}`}>
      <div className="display-grid" />
      <div className="display-scanlines" />

      <header className="display-topbar">
        <BrandLockup brand={brand} subtitle={brand.organization} />
        <div className="display-top-meta">
          <span className="hud-tag">{displayId} // {nodeDisabled ? 'DISABLED' : 'LIVE'}</span>
          <span className="hud-tag">BATCH {nodeBatch}</span>
          <div className="display-status">
            <Wifi size={14} /> <span>SYSTEM ONLINE</span><i />
          </div>
        </div>
      </header>

      <div className="display-content">
        <div className="display-kicker">
          <span>24-HOUR OFFLINE HACKATHON</span>
          <span className="mono">TIME CORE // {state.timer_status === 'RUNNING' ? 'ACTIVE' : 'STANDBY'}</span>
          <span className="mono">{nodeName} // SYNCHRONIZED</span>
        </div>

        <div className="display-main-grid">
          <div className="display-robot-column">
            <div className="side-label">
              <span>{displayId}</span>
              <span>MONITORING NODE</span>
            </div>
            <RobotVisual warning={isWarning} />
            <div className="robot-telemetry">
              <span><Cpu size={12} /> CORE TEMP <b>32.4°C</b></span>
              <span><Bluetooth size={12} /> LINK <b>STABLE</b></span>
            </div>
          </div>

          <div className="display-timer-column">
            <div className="display-heading">
              <div>
                <p>EVENT STATUS</p>
                <StatusPill status={state.timer_status} />
              </div>
              <span className="main-timer-label">MAIN TIMER</span>
            </div>

            <div className="timer-wrap">
              <div className="timer-label">HACKATHON TIME REMAINING</div>
              <div className="display-timer">{formatTime(remaining)}</div>
              <div className="timer-track">
                <span style={{ width: `${progress}%` }} />
              </div>
              <div className="timer-meta">
                <span>LOCAL EVENT CLOCK · IST</span>
                <span>{urgency === 'critical' ? 'CRITICAL WINDOW' : `${Math.round(progress)}% REMAINING`}</span>
              </div>
            </div>

            <div className="display-directive">
              <span className="eyebrow">CURRENT DIRECTIVE</span>
              <strong>
                {incomingAlert
                  ? incomingAlert.title
                  : nodeDisabled
                  ? 'NODE DISABLED BY CONTROL CENTER.'
                  : state.timer_status === 'RUNNING'
                  ? 'BUILD SOMETHING THAT MOVES THE WORLD.'
                  : state.timer_status === 'ENDED'
                  ? "TIME'S UP. GREAT WORK, BUILDERS."
                  : 'SYSTEM READY FOR EVENT INITIALIZATION.'}
              </strong>
              <p>
                {incomingAlert
                  ? incomingAlert.message
                  : nodeDisabled
                  ? 'This screen is muted for broadcasts until an operator re-enables it.'
                  : `Listening for broadcasts addressed to ALL DISPLAYS, BATCH ${nodeBatch}, or ${displayId}.`}
              </p>
            </div>
          </div>
        </div>

        <div className="display-status-row">
          <div className="status-cell">
            <Radio size={15} />
            <div>
              <span>NETWORK</span>
              <strong>ONLINE</strong>
            </div>
          </div>
          <div className="status-cell">
            <ShieldCheck size={15} />
            <div>
              <span>EVENT STATE</span>
              <strong>{state.timer_status}</strong>
            </div>
          </div>
          <div className="status-cell">
            <Activity size={15} />
            <div>
              <span>SYNC PULSE</span>
              <strong>250 MS</strong>
            </div>
          </div>
          <div className="status-cell status-time">
            <span>UTC+05:30</span>
            <strong>{new Date(now).toLocaleTimeString('en-IN', { hour12: false })}</strong>
          </div>
        </div>
      </div>

      <footer className="display-footer">
        <span>{brand.organization.toUpperCase()}</span>
        <button
          className="sound-toggle"
          onClick={() => {
            setSound(!sound);
            if (!sound) playChime('INFO');
          }}
        >
          {sound ? <Volume2 size={14} /> : <VolumeX size={14} />} {sound ? 'SOUND ENABLED' : 'ENABLE SOUND'}
        </button>
        <button
          className="sound-toggle"
          onClick={() => {
            if (confirm('Unpair this screen from ' + displayId + '? A new pairing code from the control center will be needed to reconnect it.')) {
              device.unpair();
            }
          }}
          title="Unpair this display"
        >
          <MonitorCog size={14} /> {displayId}
        </button>
        <button onClick={toggleFullscreen} aria-label="Toggle fullscreen">
          {fullscreen ? <X size={16} /> : <Fullscreen size={16} />}
        </button>
      </footer>

      {/* Alert HUD — keyed on alert.id so React fully remounts the element,
          which resets CSS animations (enter keyframes replay cleanly). The
          transition class drives the exit flash when a replacement arrives. */}
      {alert && (alertRemaining > 0 || alertTransition === 'exit') && (
        <div
          key={alert.id}
          className={`alert-hud alert-${alert.animation.toLowerCase()} alert-transition-${alertTransition}`}
          role="alert"
        >
          {/* The event clock stays visible through a broadcast — participants
              must never lose sight of how much time is left. */}
          <div className="alert-hud-header">
            <div className="alert-hud-top">
              <span><Zap size={14} /> LIVE BROADCAST // {alert.type} // {describeTarget(alert.target)}</span>
              <span>{state.timer_status === 'RUNNING' ? 'EVENT CLOCK RUNNING' : state.timer_status.replace('_', ' ')}</span>
            </div>
            <div className="alert-hud-maintimer">
              <span className="alert-hud-maintimer-label">HACKATHON TIME REMAINING</span>
              <strong>{formatTime(remaining)}</strong>
              <span className="alert-hud-maintimer-track">
                <i style={{ width: `${progress}%` }} />
              </span>
            </div>
          </div>
          <div className="alert-hud-body">
            <div className="alert-hud-icon"><Zap size={28} /></div>
            <h1>{alert.title}</h1>
            <p>{alert.message}</p>
            <div className="alert-countdown">
              <strong>{formatAlertCountdown(alertRemaining)}</strong>
              <span>ALERT REMAINING</span>
              <div className="alert-progress">
                <i style={{ width: `${alertProgress}%` }} />
              </div>
            </div>
          </div>
          <div className="alert-hud-footer">
            <span>ROBOT STATUS: WARNING</span>
            <span>{alertTransition === 'exit' ? 'REPLACING BROADCAST…' : 'AUTO-DISMISS ON ZERO'}</span>
          </div>
        </div>
      )}

      {/* Audio broadcasts sit above everything, including the alert HUD. */}
      {audio.playing && (
        <div className="audio-on-screen" role="status">
          <span className="audio-bars"><i /><i /><i /><i /></span>
          {audio.playing.kind === 'live' ? <Mic size={16} /> : <Volume2 size={16} />}
          <strong>{audio.playing.kind === 'live' ? 'LIVE ANNOUNCEMENT' : 'ANNOUNCEMENT'}</strong>
          <span>{audio.playing.title}</span>
        </div>
      )}
      {audio.blocked && (
        <button
          className="audio-on-screen audio-blocked"
          onClick={() => {
            setSound(true);
            playChime('INFO');
          }}
        >
          <VolumeX size={16} />
          <strong>{audio.blocked.kind === 'live' ? 'LIVE AUDIO' : 'AUDIO ANNOUNCEMENT'}</strong>
          <span>{audio.blocked.title} — sound is off on this screen. Tap to turn it on.</span>
        </button>
      )}
    </main>
  );
}
