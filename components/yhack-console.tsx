'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  Bell,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Command,
  Eye,
  Gauge,
  DoorOpen,
  Grid2X2,
  KeyRound,
  LifeBuoy,
  Link2,
  ListChecks,
  LogOut,
  Menu,
  Mic,
  Monitor,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Trash2,
  Users,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  useEventState,
  useAlerts,
  useDisplays,
  useBatches,
  useAuditLogs,
  controlTimer,
  adjustTimer,
  setTimerDuration,
  sendAlertNow,
  scheduleAlert,
  cancelScheduledAlert,
  dismissAlertById,
  dismissAllAlerts,
  createDisplay,
  toggleDisplay,
  deleteDisplay,
  updateDisplay,
  changeOwnPin,
  endAllSessions,
  requestPairingCode,
  updateEventDetails,
  useSession,
  useBrand,
} from '@/lib/hooks';
import {
  ALERT_TEMPLATES,
  ALL_DISPLAYS_TARGET,
  batchTarget,
  describeTarget,
  formatTime,
  formatShortTime,
  formatAlertCountdown,
  formatDurationLabel,
  alertRowRemaining,
  isAlertRowLive,
  durationToSeconds,
  splitDuration,
  DURATION_UNITS,
  type DurationUnit,
  calcAlertRemaining,
  getTimerUrgency,
  isTargetedAt,
  nodeTarget,
  roomTarget,
  type AlertType,
  type AlertAnimation,
} from '@/lib/supabase';
import { assignDisplayRoom, useRooms } from '@/lib/admin-api';
import { RoomsPanel } from '@/components/admin/rooms-panel';
import { PhasesPanel } from '@/components/admin/phases-panel';
import { IssueBoard } from '@/components/issues/issue-board';
import { useIssueAlerts, useIssues } from '@/lib/issues-api';
import { AudioPanel } from '@/components/admin/audio-panel';
import { WifiPanel } from '@/components/admin/wifi-panel';
import { useLiveBroadcast } from '@/lib/audio-client';
import { PeoplePanel } from '@/components/admin/people-panel';
import { BrandLockup } from '@/components/brand-lockup';

const navItems = [
  { label: 'Overview', icon: Grid2X2 },
  { label: 'Timer control', icon: Clock3 },
  { label: 'Alerts & messages', icon: Bell },
  { label: 'Schedule', icon: TimerReset },
  { label: 'Phases', icon: ListChecks },
  { label: 'Issues', icon: LifeBuoy },
  { label: 'Audio', icon: Mic },
  { label: 'Displays', icon: Monitor },
  { label: 'Rooms', icon: DoorOpen },
  { label: 'People', icon: Users },
  { label: 'Wi-Fi', icon: Wifi },
  { label: 'Activity log', icon: Activity },
];

function CyberFrame({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`cyber-frame ${className}`}>{children}</section>;
}

function StatusPill({ status }: { status: string }) {
  const label =
    status === 'RUNNING'
      ? 'HACKATHON LIVE'
      : status === 'PAUSED'
      ? 'SYSTEM PAUSED'
      : status === 'ENDED'
      ? 'HACKATHON COMPLETE'
      : 'SYSTEM STANDBY';
  return (
    <span className={`status-pill ${status.toLowerCase()}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

export function AdminConsole() {
  const router = useRouter();
  const { state, remaining, now, loading, error: stateError, refetch } = useEventState();
  const brand = useBrand(state);
  const { alerts, refetch: refetchAlerts } = useAlerts();
  const { displays, refetch: refetchDisplays } = useDisplays();
  const { batches } = useBatches();
  const { logs, refetch: refetchLogs } = useAuditLogs();
  const { rooms, refetch: refetchRooms } = useRooms();
  const { issues, loaded: issuesLoaded, refetch: refetchIssues } = useIssues();
  const [issueSound, setIssueSound] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('yhack26.issueSound') === 'off') setIssueSound(false);
    } catch {
      // ignore
    }
    // Arriving from a push notification: open the issue queue.
    if (new URLSearchParams(window.location.search).get('view') === 'issues') setActiveNav('Issues');
  }, []);
  const toggleIssueSound = () => {
    const next = !issueSound;
    setIssueSound(next);
    try { window.localStorage.setItem('yhack26.issueSound', next ? 'on' : 'off'); } catch { /* ignore */ }
  };
  const { latest: latestIssue, dismissLatest: dismissLatestIssue, unacknowledgedUrgent } = useIssueAlerts(issues, issuesLoaded, issueSound);
  const activeIssueCount = issues.filter((i) => i.status !== 'resolved').length;
  const liveMic = useLiveBroadcast();
  const roomNames = useMemo(() => {
    const map: Record<string, string> = {};
    rooms.forEach((r) => (map[r.id] = r.code));
    return map;
  }, [rooms]);

  const [activeNav, setActiveNav] = useState('Overview');
  const [mobileNav, setMobileNav] = useState(false);

  // Broadcast Modal State
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [alertTitle, setAlertTitle] = useState('FINAL HOUR APPROACHING');
  const [alertMessage, setAlertMessage] = useState('Only 60 minutes remain. Make every build decision count.');
  const [alertType, setAlertType] = useState<AlertType>('WARNING');
  const [alertAnimation, setAlertAnimation] = useState<AlertAnimation>('GLITCH');
  // Duration is entered as value + unit so a lunch-break notice can be set to
  // "45 minutes" or "3 hours" without counting seconds. Stored as seconds.
  const [durationValue, setDurationValue] = useState(1);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('m');
  const [broadcastError, setBroadcastError] = useState('');
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [alertTarget, setAlertTarget] = useState(ALL_DISPLAYS_TARGET);
  const [broadcasting, setBroadcasting] = useState(false);
  const alertDuration = useMemo(
    () => durationToSeconds(durationValue, durationUnit),
    [durationValue, durationUnit]
  );

  // Schedule Modal State
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');

  // Add Display Modal State
  const [displayModalOpen, setDisplayModalOpen] = useState(false);
  const [newDisplayId, setNewDisplayId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newDisplayLocation, setNewDisplayLocation] = useState('');
  const [newDisplayBatch, setNewDisplayBatch] = useState('ALL');

  // Settings Modal State
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [eventName, setEventName] = useState('');
  const [orgName, setOrgName] = useState('');
  // The shared action-error banner sits behind the modal backdrop, so a failed
  // save here has to report inside the modal or it looks like nothing happened.
  const [settingsError, setSettingsError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinSuccess, setPinSuccess] = useState('');
  const [pinError, setPinError] = useState('');

  // Failures from server actions (expired session, invalid input, conflicts)
  const [actionError, setActionError] = useState('');
  const [endingSessions, setEndingSessions] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<{ code: string; expiresAt: string; displayId: string } | null>(null);

  // Signed-in person and hard session expiry
  const { session } = useSession();

  // Activity Log Search
  const [logSearch, setLogSearch] = useState('');
  const [logFilter, setLogFilter] = useState('ALL');

  // Broadcast drafts survive a forced sign-out: sessions end on a hard clock,
  // and losing a half-written announcement to it would be maddening.
  const DRAFT_KEY = 'yhack26.alertDraft';
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (typeof d.title === 'string') setAlertTitle(d.title);
        if (typeof d.message === 'string') setAlertMessage(d.message);
        if (d.type) setAlertType(d.type);
        if (d.animation) setAlertAnimation(d.animation);
        if (typeof d.durationValue === 'number') setDurationValue(d.durationValue);
        if (d.durationUnit) setDurationUnit(d.durationUnit);
        if (typeof d.target === 'string') setAlertTarget(d.target);
      }
    } catch {
      // Storage unavailable — drafts just won't persist.
    }
    setDraftLoaded(true);
  }, []);
  useEffect(() => {
    if (!draftLoaded) return;
    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ title: alertTitle, message: alertMessage, type: alertType, animation: alertAnimation, durationValue, durationUnit, target: alertTarget })
      );
    } catch {
      // ignore
    }
  }, [draftLoaded, alertTitle, alertMessage, alertType, alertAnimation, durationValue, durationUnit, alertTarget]);
  const clearAlertDraft = () => {
    try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  };

  // Hard session clock: warn at 5 minutes, send to sign-in at zero.
  const sessionMsLeft = session ? session.expiresAt - now : null;
  const sessionWarning = sessionMsLeft !== null && sessionMsLeft > 0 && sessionMsLeft <= 5 * 60 * 1000;
  useEffect(() => {
    if (sessionMsLeft !== null && sessionMsLeft <= 0) window.location.href = '/login?reason=expired';
  }, [sessionMsLeft]);

  // Calculate Display network health
  const displayHealth = useMemo(() => {
    const total = displays.length;
    const nowMs = Date.now();
    const online = displays.filter((d) => {
      if (!d.enabled) return false;
      if (!d.last_heartbeat_at) return false;
      const last = new Date(d.last_heartbeat_at).getTime();
      return nowMs - last < 35000;
    }).length;
    return { online, total };
  }, [displays]);

  // Which registered nodes the currently selected target actually reaches
  const targetReach = useMemo(() => {
    const nowMs = Date.now();
    const matched = displays.filter((d) => d.enabled && isTargetedAt(alertTarget, d));
    const online = matched.filter(
      (d) => d.last_heartbeat_at && nowMs - new Date(d.last_heartbeat_at).getTime() < 35000
    ).length;
    return { matched: matched.length, online, names: matched.map((d) => d.display_id) };
  }, [displays, alertTarget]);

  // Scheduled alerts
  const pendingScheduled = useMemo(() => {
    return alerts.filter((a) => a.execution_status === 'PENDING');
  }, [alerts]);

  // Several broadcasts can be on air at once (different targets), so the
  // console tracks all of them rather than only the most recent.
  const liveAlerts = useMemo(
    () =>
      alerts
        .filter((a) => isAlertRowLive(a, now))
        .sort((a, b) => new Date(b.executed_at!).getTime() - new Date(a.executed_at!).getTime()),
    [alerts, now]
  );
  const urgency = getTimerUrgency(remaining);

  // Surfaces a server refusal instead of letting the click silently do nothing.
  const report = (result: { error: { message: string } | null }) => {
    setActionError(result.error ? result.error.message : '');
    return !result.error;
  };

  // Actions
  const handleControlTimer = async (action: 'start' | 'pause' | 'resume' | 'reset') => {
    if (!state) return;
    report(await controlTimer(action));
  };

  const handleAdjustTimer = async (seconds: number) => {
    if (!state) return;
    report(await adjustTimer(seconds));
  };

  const handleSetDuration = async (hours: number) => {
    if (!state) return;
    if (confirm(`Set hackathon duration to ${hours} hours? This will reset the timer.`)) {
      report(await setTimerDuration(hours * 3600));
    }
  };

  const handleSendAlert = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!state || !alertTitle.trim() || !alertMessage.trim()) return;
    setBroadcasting(true);
    setBroadcastError('');
    const { error } = await sendAlertNow({
      title: alertTitle.trim(),
      message: alertMessage.trim(),
      type: alertType,
      animation: alertAnimation,
      duration: alertDuration,
      target: alertTarget,
    });
    setBroadcasting(false);
    if (error) {
      setBroadcastError(error.message);
      return;
    }
    clearAlertDraft();
    setAlertModalOpen(false);
  };

  const handleApplyTemplate = (tmpl: typeof ALERT_TEMPLATES[0]) => {
    setAlertTitle(tmpl.title);
    setAlertMessage(tmpl.message);
    setAlertType(tmpl.type);
    setAlertAnimation(tmpl.animation);
    const split = splitDuration(tmpl.duration);
    setDurationValue(split.value);
    setDurationUnit(split.unit);
    setBroadcastError('');
    setAlertModalOpen(true);
  };

  const handleScheduleAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleDate || !alertTitle.trim() || !alertMessage.trim()) return;
    setBroadcastError('');
    const { error } = await scheduleAlert(
      {
        title: alertTitle.trim(),
        message: alertMessage.trim(),
        type: alertType,
        animation: alertAnimation,
        duration: alertDuration,
        target: alertTarget,
      },
      new Date(scheduleDate).toISOString()
    );
    if (error) {
      setBroadcastError(error.message);
      return;
    }
    clearAlertDraft();
    setScheduleModalOpen(false);
    refetchAlerts();
  };

  const handleDismissOne = async (alert: { id: string; title: string; target?: string | null }) => {
    setDismissingId(alert.id);
    report(await dismissAlertById(alert));
    setDismissingId(null);
    refetchAlerts();
    refetchLogs();
  };

  const handleDismissAll = async () => {
    if (liveAlerts.length === 0) return;
    if (!confirm(`Take all ${liveAlerts.length} live broadcast(s) off air?`)) return;
    setDismissingId('ALL');
    report(await dismissAllAlerts(liveAlerts));
    setDismissingId(null);
    refetchAlerts();
    refetchLogs();
  };

  const handleCreateDisplay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDisplayId.trim() || !newDisplayName.trim()) return;
    const created = await createDisplay({
      display_id: newDisplayId.trim().toUpperCase(),
      display_name: newDisplayName.trim(),
      location: newDisplayLocation.trim() || 'Venue',
      batch: newDisplayBatch,
    });
    if (!report(created)) return;
    setNewDisplayId('');
    setNewDisplayName('');
    setNewDisplayLocation('');
    setDisplayModalOpen(false);
    refetchDisplays();
  };

  // Batch options always include whatever a node is currently assigned to,
  // even if that value predates the batch registry.
  const batchOptions = useMemo(() => {
    const names = new Set<string>(['ALL']);
    batches.forEach((b) => names.add(b.name));
    displays.forEach((d) => names.add(d.batch));
    return Array.from(names);
  }, [batches, displays]);

  const handleUpdateDisplayBatch = async (id: string, _displayId: string, batch: string) => {
    report(await updateDisplay(id, { batch }));
    refetchDisplays();
  };

  const handleToggleDisplay = async (id: string, _displayId: string, current: boolean) => {
    report(await toggleDisplay(id, !current));
    refetchDisplays();
  };

  const handleDeleteDisplay = async (id: string, displayId: string) => {
    if (confirm(`Remove display ${displayId} from registry? Its paired kiosk will stop working.`)) {
      report(await deleteDisplay(id));
      refetchDisplays();
    }
  };

  const handleRequestPairingCode = async (id: string, displayId: string) => {
    if (!confirm(`Generate a pairing code for ${displayId}? Any kiosk currently paired to it will be disconnected.`)) return;
    const result = await requestPairingCode(id);
    if (report(result) && result.data) setPairingInfo(result.data);
  };

  const handleUpdatePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');
    setPinSuccess('');
    if (!/^\d{6,12}$/.test(newPin)) {
      setPinError('PIN must be 6–12 digits.');
      return;
    }
    if (newPin !== pinConfirm) {
      setPinError('PINs do not match');
      return;
    }
    const { error } = await changeOwnPin(currentPin, newPin);
    if (error) {
      setPinError(error.message);
    } else {
      setPinSuccess('PIN updated. Your other signed-in devices were signed out.');
      setCurrentPin('');
      setNewPin('');
      setPinConfirm('');
    }
  };

  const handleEndAllSessions = async () => {
    if (!confirm('Sign out every admin, operator and participant on every device? You stay signed in here. Display screens are not affected.')) return;
    setEndingSessions(true);
    const ok = report(await endAllSessions());
    setEndingSessions(false);
    if (ok) setPinSuccess('All other sessions have been ended.');
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state) return;
    setSettingsError('');
    setSettingsSaved('');
    const { error } = await updateEventDetails({
      event_name: eventName.trim() || state.event_name,
      organization: orgName.trim() || state.organization,
    });
    if (error) {
      setSettingsError(error.message);
      return;
    }
    // Every screen picks the new name up on its next poll (within ~15s);
    // refetch here so this console shows it immediately.
    await refetch();
    setSettingsSaved('Saved. Displays and portals update within a few seconds.');
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  // Filtered logs
  const filteredLogs = useMemo(() => {
    return logs.filter((item) => {
      const matchText =
        item.action.toLowerCase().includes(logSearch.toLowerCase()) ||
        (item.details && item.details.toLowerCase().includes(logSearch.toLowerCase())) ||
        (item.target && item.target.toLowerCase().includes(logSearch.toLowerCase())) ||
        item.actor.toLowerCase().includes(logSearch.toLowerCase());
      if (!matchText) return false;
      if (logFilter === 'ALL') return true;
      return item.action.startsWith(logFilter);
    });
  }, [logs, logSearch, logFilter]);

  if (loading || !state) {
    return (
      <main className="display-shell display-loading">
        <div className="display-loader">
          <div className="brand-mark">Y</div>
          <span>CONNECTING TO OPERATIONAL CORE</span>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      {/* Sidebar Navigation */}
      <aside className={mobileNav ? 'admin-sidebar open' : 'admin-sidebar'}>
        <BrandLockup brand={brand} subtitle="CONTROL CENTER" className="admin-brand" />

        <div className="workspace-label">
          EVENT WORKSPACE <span>LIVE</span>
        </div>

        <nav>
          {navItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={activeNav === label ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setActiveNav(label);
                setMobileNav(false);
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              {label === 'Alerts & messages' && liveAlerts.length > 0 && <b>{liveAlerts.length}</b>}
              {label === 'Schedule' && pendingScheduled.length > 0 && <b>{pendingScheduled.length}</b>}
              {label === 'Audio' && liveMic.sessionId && <b className="nav-badge-urgent">LIVE</b>}
              {label === 'Issues' && activeIssueCount > 0 && (
                <b className={unacknowledgedUrgent.length > 0 ? 'nav-badge-urgent' : ''}>{activeIssueCount}</b>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="operator">
            <div className="operator-avatar">{session ? session.name.slice(0, 2).toUpperCase() : 'AD'}</div>
            <div>
              <strong>{session ? session.name : 'Administrator'}</strong>
              <span>
                {session ? session.accountId : 'Signing in…'}
                {sessionMsLeft !== null && sessionMsLeft > 0 ? ' · ' + formatShortTime(Math.floor(sessionMsLeft / 1000)) + ' left' : ''}
              </span>
            </div>
            <ChevronRight size={16} />
          </div>
          <button
            className="settings-link"
            onClick={() => {
              setEventName(state.event_name);
              setOrgName(state.organization);
              setSettingsError('');
              setSettingsSaved('');
              setSettingsModalOpen(true);
            }}
          >
            <Settings2 size={16} /> System Settings
          </button>
          <button className="settings-link" onClick={handleLogout} style={{ color: '#ff7584' }}>
            <LogOut size={16} /> End Session
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <section className="admin-main">
        <header className="admin-header">
          <button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)}>
            <Menu />
          </button>
          <div>
            <div className="breadcrumb">
              {state.event_name} <ChevronRight size={13} /> {activeNav.toUpperCase()}
            </div>
            <h1>{activeNav === 'Overview' ? 'Good day, operator.' : activeNav}</h1>
          </div>
          <div className="header-actions">
            <div className="header-online">
              <i /> SERVER ONLINE <span>·</span> {displayHealth.online} / {displayHealth.total} DISPLAYS
            </div>
            <a href="/display" target="_blank" rel="noreferrer" className="outline-action">
              <Eye size={16} /> Launch Display Screen
            </a>
          </div>
        </header>

        <div className="admin-scroll">
          {sessionWarning && (
            <div className="session-warning" role="alert">
              <strong>Session ends in {formatShortTime(Math.floor((sessionMsLeft || 0) / 1000))}.</strong>
              <span>Sessions are limited to one hour. Unsent broadcast drafts are kept — sign in again to continue.</span>
            </div>
          )}

          {liveMic.sessionId && activeNav !== 'Audio' && (
            <div className="on-air-banner console-on-air">
              <span className="on-air-dot" />
              <strong>MIC LIVE · {liveMic.title}</strong>
              <span>
                {liveMic.peers.filter((p) => p.state === 'connected').length}/{liveMic.peers.length} screens
                {liveMic.muted ? ' · muted' : ''}
              </span>
              <button className="inline-dismiss" onClick={() => setActiveNav('Audio')}>Open</button>
              <button className="inline-dismiss" onClick={liveMic.stop}>End</button>
            </div>
          )}

          {unacknowledgedUrgent.length > 0 && (
            <button className="urgent-issue-banner" onClick={() => setActiveNav('Issues')}>
              <LifeBuoy size={18} />
              <strong>
                {unacknowledgedUrgent.length} urgent issue{unacknowledgedUrgent.length === 1 ? '' : 's'} waiting
              </strong>
              <span>
                {unacknowledgedUrgent[0].title}
                {unacknowledgedUrgent[0].room_code ? ' · ' + unacknowledgedUrgent[0].room_code : ''} — open the queue
              </span>
            </button>
          )}

          {latestIssue && latestIssue.priority !== 'urgent' && activeNav !== 'Issues' && (
            <div className="new-issue-toast" role="status">
              <LifeBuoy size={15} />
              <span>
                New issue: <strong>{latestIssue.title}</strong>
                {latestIssue.room_code ? ' · ' + latestIssue.room_code : ''}
              </span>
              <button className="inline-dismiss" onClick={() => { setActiveNav('Issues'); dismissLatestIssue(); }}>View</button>
              <button className="icon-danger" onClick={dismissLatestIssue} aria-label="Dismiss"><X size={14} /></button>
            </div>
          )}

          {actionError && (
            <div className="action-error" role="alert">
              <span>{actionError}</span>
              <button onClick={() => setActionError('')} aria-label="Dismiss error"><X size={14} /></button>
            </div>
          )}

          {/* Every broadcast currently on air, each independently dismissable */}
          {liveAlerts.length > 0 && (
            <div className="live-alert-stack">
              <div className="live-alert-stack-head">
                <span className="eyebrow">
                  ON AIR NOW — {liveAlerts.length} BROADCAST{liveAlerts.length === 1 ? '' : 'S'}
                </span>
                {liveAlerts.length > 1 && (
                  <button
                    className="dismiss-all-action"
                    onClick={handleDismissAll}
                    disabled={dismissingId === 'ALL'}
                  >
                    <X size={13} /> {dismissingId === 'ALL' ? 'Clearing…' : 'Dismiss all'}
                  </button>
                )}
              </div>

              {liveAlerts.map((a) => (
                <div key={a.id} className="alert-preview live-alert-row">
                  <div className="preview-icon">
                    <Zap size={20} />
                  </div>
                  <div>
                    <span style={{ color: 'var(--red-bright)' }}>
                      {a.message_type} // {describeTarget(a.target, roomNames)} ({formatAlertCountdown(alertRowRemaining(a, now))} remaining)
                    </span>
                    <strong style={{ fontSize: 15 }}>{a.title}</strong>
                    <p>{a.message}</p>
                  </div>
                  <button
                    onClick={() => handleDismissOne(a)}
                    disabled={dismissingId === a.id}
                    title={`Take "${a.title}" off air`}
                    style={{ width: 'auto', padding: '6px 12px', gap: 6, display: 'flex', alignItems: 'center' }}
                  >
                    <X size={14} /> {dismissingId === a.id ? 'Clearing…' : 'Dismiss'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* =================================================================
              VIEW 1: OVERVIEW
             ================================================================= */}
          {activeNav === 'Overview' && (
            <div className="view-container">
              <div className="overview-intro">
                <div>
                  <span className="eyebrow">
                    {new Date(now).toLocaleDateString('en-IN', {
                      weekday: 'long',
                      day: '2-digit',
                      month: 'long',
                      year: 'numeric',
                    })}{' '}
                    · {new Date(now).toLocaleTimeString('en-IN', { hour12: false })} IST
                  </span>
                  <p>Real-time operational dashboard for {state.event_name}.</p>
                </div>
                <button className="primary-action" onClick={() => setAlertModalOpen(true)}>
                  <Send size={16} /> Broadcast Alert
                </button>
              </div>

              <div className="metric-grid">
                <CyberFrame className="hero-metric">
                  <div className="metric-top">
                    <span className="eyebrow">HACKATHON COUNTDOWN</span>
                    <StatusPill status={state.timer_status} />
                  </div>
                  <div className="admin-timer">{formatTime(remaining)}</div>
                  <div className="hero-actions">
                    {state.timer_status === 'RUNNING' ? (
                      <button onClick={() => handleControlTimer('pause')}>
                        <Pause size={15} /> Pause Timer
                      </button>
                    ) : (
                      <button onClick={() => handleControlTimer(state.timer_status === 'PAUSED' ? 'resume' : 'start')}>
                        <Play size={15} /> {state.timer_status === 'PAUSED' ? 'Resume Timer' : 'Start Hackathon'}
                      </button>
                    )}
                    <button className="muted-action" onClick={() => handleControlTimer('reset')}>
                      <RotateCcw size={15} /> Reset
                    </button>
                  </div>
                </CyberFrame>

                <CyberFrame>
                  <div className="small-metric-label">
                    <Monitor size={16} /> DISPLAY NETWORK <span className="live-chip">LIVE</span>
                  </div>
                  <div className="stat-value">
                    {displayHealth.online}
                    <small> / {displayHealth.total}</small>
                  </div>
                  <div className="stat-caption">
                    <span className="green-dot" /> nodes online{' '}
                    {displayHealth.total - displayHealth.online > 0 && (
                      <span className="warning-text">
                        {displayHealth.total - displayHealth.online} offline
                      </span>
                    )}
                  </div>
                  <div className="mini-bars">
                    {displays.map((d, i) => {
                      const isOnline =
                        d.enabled &&
                        d.last_heartbeat_at &&
                        now - new Date(d.last_heartbeat_at).getTime() < 35000;
                      return <span key={d.id || i} className={isOnline ? '' : 'off'} title={`${d.display_id}: ${isOnline ? 'Online' : 'Offline'}`} />;
                    })}
                  </div>
                </CyberFrame>

                <CyberFrame>
                  <div className="small-metric-label">
                    <Bell size={16} /> SCHEDULED ALERTS
                  </div>
                  <div className="schedule-time">
                    {pendingScheduled.length > 0 ? (
                      new Date(pendingScheduled[0].scheduled_for!).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true,
                      })
                    ) : (
                      'None'
                    )}
                  </div>
                  <div className="stat-caption">
                    {pendingScheduled.length > 0
                      ? pendingScheduled[0].title
                      : 'All scheduled alerts clear'}
                  </div>
                  {pendingScheduled.length > 0 && (
                    <div className="schedule-line">
                      <i /> {pendingScheduled.length} pending broadcast{pendingScheduled.length > 1 ? 's' : ''}
                    </div>
                  )}
                </CyberFrame>
              </div>

              <div className="control-grid">
                <CyberFrame className="timer-control">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">QUICK TIME ADJUSTMENTS</span>
                      <h2>Adjust countdown remaining</h2>
                    </div>
                    <Gauge size={20} />
                  </div>
                  <div className="adjust-row">
                    <button onClick={() => handleAdjustTimer(-600)}>−10m</button>
                    <button onClick={() => handleAdjustTimer(-60)}>−1m</button>
                    <button onClick={() => handleAdjustTimer(60)}>+1m</button>
                    <button onClick={() => handleAdjustTimer(300)}>+5m</button>
                    <button onClick={() => handleAdjustTimer(600)}>+10m</button>
                  </div>
                  <div className="timer-note">
                    <Sparkles size={14} /> Instant synchronization to all connected venue displays.
                  </div>
                </CyberFrame>

                <CyberFrame>
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">RECENT ACTIVITY</span>
                      <h2>Control Room Log</h2>
                    </div>
                    <Activity size={20} />
                  </div>
                  <div className="activity-list">
                    {logs.slice(0, 5).map((item, index) => (
                      <div className="activity-item" key={item.id || index}>
                        <i className={index === 0 ? 'activity-live' : ''} />
                        <div>
                          <strong>
                            {item.action}: {item.details || item.target || 'Action executed'}
                          </strong>
                          <span>
                            {new Date(item.created_at).toLocaleTimeString('en-IN', { hour12: false })} · by {item.actor}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CyberFrame>
              </div>
            </div>
          )}

          {/* =================================================================
              VIEW 2: TIMER CONTROL
             ================================================================= */}
          {activeNav === 'Timer control' && (
            <div className="view-container">
              <CyberFrame>
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">MASTER EVENT TIMER</span>
                    <h2>Control and synchronize countdown clock</h2>
                  </div>
                  <StatusPill status={state.timer_status} />
                </div>

                <div style={{ textAlign: 'center', padding: '36px 0 20px' }}>
                  <div className="display-timer" style={{ fontSize: 'clamp(56px, 10vw, 120px)' }}>
                    {formatTime(remaining)}
                  </div>
                  <div className="timer-track" style={{ maxWidth: 640, margin: '0 auto 16px' }}>
                    <span
                      style={{
                        width: `${
                          state.duration_seconds
                            ? Math.min(100, Math.max(0, (remaining / state.duration_seconds) * 100))
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <span className="eyebrow" style={{ color: 'var(--soft)' }}>
                    {state.duration_seconds / 3600} HOUR EVENT · STATUS: {state.timer_status}
                  </span>
                </div>

                <div className="hero-actions" style={{ justifyContent: 'center', margin: '20px 0 30px' }}>
                  {state.timer_status === 'RUNNING' ? (
                    <button onClick={() => handleControlTimer('pause')} style={{ padding: '12px 24px', fontSize: 13 }}>
                      <Pause size={18} /> Pause Countdown
                    </button>
                  ) : (
                    <button
                      onClick={() => handleControlTimer(state.timer_status === 'PAUSED' ? 'resume' : 'start')}
                      style={{ padding: '12px 24px', fontSize: 13 }}
                    >
                      <Play size={18} /> {state.timer_status === 'PAUSED' ? 'Resume Countdown' : 'Start Hackathon'}
                    </button>
                  )}
                  <button
                    className="muted-action"
                    onClick={() => handleControlTimer('reset')}
                    style={{ padding: '12px 20px', fontSize: 13 }}
                  >
                    <RotateCcw size={18} /> Reset to Duration
                  </button>
                </div>

                <div className="adjust-row" style={{ maxWidth: 720, margin: '0 auto' }}>
                  <button onClick={() => handleAdjustTimer(-1800)}>−30m</button>
                  <button onClick={() => handleAdjustTimer(-600)}>−10m</button>
                  <button onClick={() => handleAdjustTimer(-300)}>−5m</button>
                  <button onClick={() => handleAdjustTimer(-60)}>−1m</button>
                  <button onClick={() => handleAdjustTimer(60)}>+1m</button>
                  <button onClick={() => handleAdjustTimer(300)}>+5m</button>
                  <button onClick={() => handleAdjustTimer(600)}>+10m</button>
                  <button onClick={() => handleAdjustTimer(1800)}>+30m</button>
                </div>
              </CyberFrame>

              <CyberFrame>
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">CONFIGURE EVENT DURATION</span>
                    <h2>Set standard hackathon duration</h2>
                  </div>
                  <Clock3 size={20} />
                </div>
                <p style={{ color: 'var(--muted)', fontSize: 12, margin: '8px 0 20px' }}>
                  Selecting a duration presets the timer and marks it in standby ready to start.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
                  {[12, 24, 36, 48].map((h) => (
                    <button
                      key={h}
                      onClick={() => handleSetDuration(h)}
                      className={state.duration_seconds === h * 3600 ? 'primary-action' : 'outline-action'}
                      style={{ justifyContent: 'center', padding: '16px 20px', fontSize: 14 }}
                    >
                      {h} Hours {state.duration_seconds === h * 3600 ? ' (Active)' : ''}
                    </button>
                  ))}
                </div>
              </CyberFrame>
            </div>
          )}

          {/* =================================================================
              VIEW 3: ALERTS & MESSAGES
             ================================================================= */}
          {activeNav === 'Alerts & messages' && (
            <div className="view-container">
              <div className="overview-intro">
                <div>
                  <span className="eyebrow">BROADCAST SYSTEM</span>
                  <p>Send urgent notifications, updates, and templates to venue screens.</p>
                </div>
                <button className="primary-action" onClick={() => setAlertModalOpen(true)}>
                  <Send size={16} /> New Broadcast
                </button>
              </div>

              <CyberFrame>
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">ONE-CLICK PRE-MADE TEMPLATES</span>
                    <h2>Select a broadcast template</h2>
                  </div>
                  <Sparkles size={20} />
                </div>

                <div className="templates-grid">
                  {ALERT_TEMPLATES.map((tmpl, idx) => (
                    <div className="template-card" key={idx}>
                      <div>
                        <span className={`template-badge badge-${tmpl.type}`}>{tmpl.type}</span>
                        <strong style={{ display: 'block', marginTop: 8 }}>{tmpl.title}</strong>
                        <p>{tmpl.message}</p>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                        <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                          {tmpl.duration}s · {tmpl.animation}
                        </span>
                        <button onClick={() => handleApplyTemplate(tmpl)}>Use Template</button>
                      </div>
                    </div>
                  ))}
                </div>
              </CyberFrame>

              <CyberFrame>
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">BROADCAST LOG</span>
                    <h2>Recent sent alerts</h2>
                  </div>
                  <Bell size={20} />
                </div>

                <div className="cyber-table-wrap">
                  <table className="cyber-table">
                    <thead>
                      <tr>
                        <th>TITLE</th>
                        <th>TARGET</th>
                        <th>TYPE</th>
                        <th>DURATION</th>
                        <th>STATUS</th>
                        <th>SENT AT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <strong>{a.title}</strong>
                            <div style={{ color: 'var(--muted)', fontSize: 10 }}>{a.message}</div>
                          </td>
                          <td>{describeTarget(a.target, roomNames)}</td>
                          <td>
                            <span className={`template-badge badge-${a.message_type}`}>{a.message_type}</span>
                          </td>
                          <td>{formatDurationLabel(a.duration_seconds)}</td>
                          <td>
                            {isAlertRowLive(a, now) ? (
                              <span className="live-alert-cell">
                                <span className="live-dot" />
                                ON AIR · {formatAlertCountdown(alertRowRemaining(a, now))}
                                <button
                                  className="inline-dismiss"
                                  onClick={() => handleDismissOne(a)}
                                  disabled={dismissingId === a.id}
                                  title={`Take "${a.title}" off air`}
                                >
                                  {dismissingId === a.id ? '…' : 'Dismiss'}
                                </button>
                              </span>
                            ) : (
                              <span style={{ color: a.execution_status === 'CANCELLED' ? 'var(--muted)' : 'var(--green)' }}>
                                {a.execution_status}
                              </span>
                            )}
                          </td>
                          <td>{new Date(a.created_at).toLocaleTimeString('en-IN', { hour12: false })}</td>
                        </tr>
                      ))}
                      {alerts.length === 0 && (
                        <tr>
                          <td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                            No broadcast alerts sent yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CyberFrame>
            </div>
          )}

          {/* =================================================================
              VIEW 4: SCHEDULE
             ================================================================= */}
          {activeNav === 'Schedule' && (
            <div className="view-container">
              <div className="overview-intro">
                <div>
                  <span className="eyebrow">TIMED BROADCASTS</span>
                  <p>Schedule alerts to automatically trigger at specific event milestones.</p>
                </div>
                <button
                  className="primary-action"
                  onClick={() => {
                    // Default to 10 minutes from now
                    const inTenMin = new Date(Date.now() + 10 * 60000);
                    setScheduleDate(inTenMin.toISOString().slice(0, 16));
                    setScheduleModalOpen(true);
                  }}
                >
                  <Calendar size={16} /> Schedule Alert
                </button>
              </div>

              <CyberFrame>
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">SCHEDULE QUEUE</span>
                    <h2>Pending scheduled announcements</h2>
                  </div>
                  <TimerReset size={20} />
                </div>

                <div className="cyber-table-wrap">
                  <table className="cyber-table">
                    <thead>
                      <tr>
                        <th>SCHEDULED TIME</th>
                        <th>TITLE & DIRECTIVE</th>
                        <th>TARGET</th>
                        <th>TYPE</th>
                        <th>DURATION</th>
                        <th>ACTION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingScheduled.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong style={{ color: 'var(--cyan)' }}>
                              {item.scheduled_for ? new Date(item.scheduled_for).toLocaleTimeString('en-IN') : 'N/A'}
                            </strong>
                            <div style={{ color: 'var(--muted)', fontSize: 10 }}>
                              {item.scheduled_for ? new Date(item.scheduled_for).toLocaleDateString('en-IN') : ''}
                            </div>
                          </td>
                          <td>
                            <strong>{item.title}</strong>
                            <div style={{ color: 'var(--muted)', fontSize: 10 }}>{item.message}</div>
                          </td>
                          <td>{describeTarget(item.target, roomNames)}</td>
                          <td>
                            <span className={`template-badge badge-${item.message_type}`}>{item.message_type}</span>
                          </td>
                          <td>{formatDurationLabel(item.duration_seconds)}</td>
                          <td>
                            <button
                              onClick={async () => { report(await cancelScheduledAlert(item.id)); refetchAlerts(); }}
                              style={{
                                background: 'none',
                                border: '1px solid var(--line-light)',
                                color: '#ff7584',
                                padding: '4px 8px',
                                fontSize: 10,
                              }}
                            >
                              Cancel
                            </button>
                          </td>
                        </tr>
                      ))}
                      {pendingScheduled.length === 0 && (
                        <tr>
                          <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                            No scheduled alerts in the queue. Click &quot;Schedule Alert&quot; to queue a future announcement.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CyberFrame>
            </div>
          )}

          {/* =================================================================
              VIEW 5: DISPLAYS
             ================================================================= */}
          {activeNav === 'Displays' && (
            <div className="view-container">
              <div className="overview-intro">
                <div>
                  <span className="eyebrow">NODE REGISTRY</span>
                  <p>Manage physical display screens, kiosks, and projectors connected across the venue.</p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="primary-action" onClick={() => setDisplayModalOpen(true)}>
                    <Plus size={16} /> Register Display Node
                  </button>
                  <a href="/display" target="_blank" rel="noreferrer" className="outline-action">
                    <Eye size={16} /> Open Kiosk Screen
                  </a>
                </div>
              </div>

              <div className="metric-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                <CyberFrame>
                  <div className="small-metric-label">
                    <Monitor size={16} /> REGISTERED NODES
                  </div>
                  <div className="stat-value">{displays.length}</div>
                  <div className="stat-caption">Total screen endpoints configured</div>
                </CyberFrame>
                <CyberFrame>
                  <div className="small-metric-label">
                    <Wifi size={16} /> ONLINE NODES
                  </div>
                  <div className="stat-value" style={{ color: 'var(--green)' }}>
                    {displayHealth.online}
                  </div>
                  <div className="stat-caption">Pinging heartbeat within last 35s</div>
                </CyberFrame>
                <CyberFrame>
                  <div className="small-metric-label">
                    <ShieldAlert size={16} /> OFFLINE / ATTENTION
                  </div>
                  <div className="stat-value" style={{ color: displayHealth.total - displayHealth.online > 0 ? 'var(--amber)' : 'var(--muted)' }}>
                    {displayHealth.total - displayHealth.online}
                  </div>
                  <div className="stat-caption">Nodes requiring network verification</div>
                </CyberFrame>
              </div>

              <CyberFrame>
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">CONNECTED VENUE SCREENS</span>
                    <h2>Display endpoints directory</h2>
                  </div>
                  <Monitor size={20} />
                </div>

                <div className="cyber-table-wrap">
                  <table className="cyber-table">
                    <thead>
                      <tr>
                        <th>STATUS</th>
                        <th>DISPLAY ID</th>
                        <th>NAME & LOCATION</th>
                        <th>ROOM</th>
                        <th>BATCH TARGET</th>
                        <th>LAST HEARTBEAT</th>
                        <th>ACTIVE</th>
                        <th>ACTIONS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displays.map((disp) => {
                        const isOnline =
                          disp.enabled &&
                          disp.last_heartbeat_at &&
                          now - new Date(disp.last_heartbeat_at).getTime() < 35000;
                        return (
                          <tr key={disp.id}>
                            <td>
                              <span className={`node-status ${isOnline ? 'online' : 'offline'}`} />
                            </td>
                            <td>
                              <strong style={{ color: 'var(--white)' }}>{disp.display_id}</strong>
                            </td>
                            <td>
                              <strong>{disp.display_name}</strong>
                              <div style={{ color: 'var(--muted)', fontSize: 10 }}>{disp.location}</div>
                            </td>
                            <td>
                              <select
                                className="inline-batch-select"
                                value={disp.room_id || ''}
                                onChange={async (e) => {
                                  report(await assignDisplayRoom(disp.id, e.target.value || null));
                                  refetchDisplays();
                                  refetchRooms();
                                }}
                                title={rooms.length ? 'Room this display belongs to' : 'Create rooms in the Rooms tab first'}
                              >
                                <option value="">— none —</option>
                                {rooms.map((r) => (
                                  <option key={r.id} value={r.id}>{r.code}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                className="inline-batch-select"
                                value={disp.batch}
                                onChange={(e) => handleUpdateDisplayBatch(disp.id, disp.display_id, e.target.value)}
                                title="Change the batch this node receives alerts for"
                              >
                                {batchOptions.map((name) => (
                                  <option key={name} value={name}>{name}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              {disp.last_heartbeat_at ? (
                                <span>{new Date(disp.last_heartbeat_at).toLocaleTimeString('en-IN')}</span>
                              ) : (
                                <span style={{ color: 'var(--muted)' }}>No ping</span>
                              )}
                            </td>
                            <td>
                              <button
                                onClick={() => handleToggleDisplay(disp.id, disp.display_id, disp.enabled)}
                                style={{
                                  padding: '4px 8px',
                                  fontSize: 10,
                                  background: disp.enabled ? 'rgba(63, 185, 80, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                                  border: '1px solid',
                                  borderColor: disp.enabled ? 'var(--green)' : 'var(--line)',
                                  color: disp.enabled ? 'var(--green)' : 'var(--muted)',
                                }}
                              >
                                {disp.enabled ? 'ENABLED' : 'DISABLED'}
                              </button>
                            </td>
                            <td>
                              <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                                <button
                                  onClick={() => handleRequestPairingCode(disp.id, disp.display_id)}
                                  title="Generate a pairing code for a kiosk"
                                  className="inline-dismiss"
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                >
                                  <Link2 size={12} /> Pair
                                </button>
                                <button
                                  onClick={() => handleDeleteDisplay(disp.id, disp.display_id)}
                                  title="Delete node"
                                  style={{ background: 'none', border: 0, color: 'var(--muted)' }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CyberFrame>
            </div>
          )}

          {/* =================================================================
              VIEW 6: ACTIVITY LOG
             ================================================================= */}
          {activeNav === 'Phases' && <PhasesPanel now={now} />}

          {activeNav === 'Issues' && (
            <IssueBoard
              issues={issues}
              refetch={refetchIssues}
              rooms={rooms}
              canRaiseWithoutRoom
              soundOn={issueSound}
              onToggleSound={toggleIssueSound}
              now={now}
            />
          )}

          {activeNav === 'Audio' && (
            <AudioPanel live={liveMic} rooms={rooms} roomNames={roomNames} batches={batches} displays={displays} now={now} />
          )}

          {activeNav === 'Rooms' && <RoomsPanel onChanged={() => { refetchRooms(); refetchDisplays(); }} />}

          {activeNav === 'People' && <PeoplePanel currentAccountId={session ? session.accountId : null} />}

          {activeNav === 'Wi-Fi' && <WifiPanel />}

          {activeNav === 'Activity log' && (
            <div className="view-container">
              <div className="overview-intro">
                <div>
                  <span className="eyebrow">AUDIT STREAM</span>
                  <p>Tamper-evident operations log capturing every operator command and timer adjustment.</p>
                </div>
              </div>

              <CyberFrame>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
                  <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
                    <input
                      type="text"
                      placeholder="Search audit actions, details, targets..."
                      value={logSearch}
                      onChange={(e) => setLogSearch(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '9px 12px 9px 36px',
                        background: '#090b0d',
                        border: '1px solid var(--line-light)',
                        color: 'white',
                        font: '12px ui-monospace, monospace',
                      }}
                    />
                    <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--muted)' }} />
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    {['ALL', 'TIMER', 'ALERT', 'DISPLAY', 'PIN'].map((f) => (
                      <button
                        key={f}
                        onClick={() => setLogFilter(f)}
                        style={{
                          padding: '6px 12px',
                          background: logFilter === f ? 'var(--red)' : '#14171c',
                          border: '1px solid',
                          borderColor: logFilter === f ? 'var(--red-bright)' : 'var(--line-light)',
                          color: logFilter === f ? 'white' : 'var(--muted)',
                          font: '600 10px ui-monospace, monospace',
                        }}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cyber-table-wrap">
                  <table className="cyber-table">
                    <thead>
                      <tr>
                        <th>ACTION</th>
                        <th>ACTOR</th>
                        <th>TARGET</th>
                        <th>DETAILS</th>
                        <th>TIMESTAMP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLogs.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong
                              style={{
                                color: item.action.startsWith('ALERT')
                                  ? 'var(--red-bright)'
                                  : item.action.startsWith('TIMER')
                                  ? 'var(--cyan)'
                                  : 'var(--white)',
                              }}
                            >
                              {item.action}
                            </strong>
                          </td>
                          <td>
                            <span className="template-badge badge-INFO">{item.actor}</span>
                          </td>
                          <td>{item.target || '—'}</td>
                          <td>{item.details || '—'}</td>
                          <td>{new Date(item.created_at).toLocaleString('en-IN')}</td>
                        </tr>
                      ))}
                      {filteredLogs.length === 0 && (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                            No log events matching filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CyberFrame>
            </div>
          )}
        </div>
      </section>

      {/* =====================================================================
          MODAL: SEND INSTANT BROADCAST
         ===================================================================== */}
      {alertModalOpen && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setAlertModalOpen(false)}>
              <X size={18} />
            </button>
            <span className="eyebrow">NEW BROADCAST DIRECTIVE</span>
            <h2>Send Venue Alert</h2>
            <p>Broadcast a high-priority message directly to venue display screens.</p>

            <form onSubmit={handleSendAlert}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label>
                  Alert Type
                  <select value={alertType} onChange={(e) => setAlertType(e.target.value as AlertType)}>
                    <option value="INFO">INFO</option>
                    <option value="WARNING">WARNING</option>
                    <option value="ALERT">ALERT</option>
                    <option value="URGENT">URGENT</option>
                    <option value="SUCCESS">SUCCESS</option>
                    <option value="ANNOUNCEMENT">ANNOUNCEMENT</option>
                  </select>
                </label>
                <label>
                  Animation Style
                  <select value={alertAnimation} onChange={(e) => setAlertAnimation(e.target.value as AlertAnimation)}>
                    <option value="GLITCH">GLITCH</option>
                    <option value="HUD">HUD EXPAND</option>
                    <option value="SLIDE">SLIDE DOWN</option>
                    <option value="WARNING">FLASHING WARNING</option>
                    <option value="PULSE">RADIAL PULSE</option>
                    <option value="FADE">SMOOTH FADE</option>
                  </select>
                </label>
              </div>

              <label>
                Directive Title
                <input
                  value={alertTitle}
                  onChange={(e) => setAlertTitle(e.target.value)}
                  placeholder="e.g. LUNCH BREAK IS LIVE"
                  required
                />
              </label>

              <label>
                Message Details
                <textarea
                  value={alertMessage}
                  onChange={(e) => setAlertMessage(e.target.value)}
                  placeholder="e.g. Please proceed to the dining hall."
                  required
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label>
                  Display Duration
                  <span className="duration-field">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={durationValue}
                      onChange={(e) => setDurationValue(Math.max(1, Number(e.target.value)))}
                      required
                    />
                    <select value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}>
                      {DURATION_UNITS.map((u) => (
                        <option key={u.key} value={u.key}>{u.label}</option>
                      ))}
                    </select>
                  </span>
                  <small className="duration-hint">
                    Stays up for {formatDurationLabel(alertDuration)} — the event timer keeps running underneath.
                  </small>
                </label>
                <label>
                  Target Audience
                  <select value={alertTarget} onChange={(e) => setAlertTarget(e.target.value)}>
                    <option value={ALL_DISPLAYS_TARGET}>{ALL_DISPLAYS_TARGET}</option>
                    {rooms.length > 0 && (
                      <optgroup label="Rooms">
                        {rooms.map((r) => (
                          <option key={r.id} value={roomTarget(r.id)}>
                            ROOM: {r.code} — {r.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Batches">
                      {batches.map((b) => (
                        <option key={b.id} value={batchTarget(b.name)}>
                          BATCH: {b.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Individual devices">
                      {displays.map((d) => (
                        <option key={d.id} value={nodeTarget(d.display_id)}>
                          {d.display_id} — {d.display_name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
              </div>

              <div className="modal-target">
                <span>Target:</span>
                <strong>{describeTarget(alertTarget, roomNames)}</strong>
                <span className="target-online">
                  <i /> {targetReach.online}/{targetReach.matched} targeted screens online
                </span>
              </div>
              {targetReach.matched === 0 && (
                <div className="target-warning">
                  No enabled display matches this target — the broadcast will be logged but nothing will show it.
                </div>
              )}
              {targetReach.matched > 0 && (
                <div className="target-reach">Reaches: {targetReach.names.join(', ')}</div>
              )}

              {broadcastError && <div className="modal-error">{broadcastError}</div>}

              <button type="submit" disabled={broadcasting} className="primary-action modal-send">
                <Send size={16} /> {broadcasting ? 'Transmitting...' : 'Broadcast Now'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: SCHEDULE ALERT
         ===================================================================== */}
      {scheduleModalOpen && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setScheduleModalOpen(false)}>
              <X size={18} />
            </button>
            <span className="eyebrow">SCHEDULED DIRECTIVE</span>
            <h2>Queue Future Alert</h2>
            <p>Alert will automatically broadcast to displays at the specified time.</p>

            <form onSubmit={handleScheduleAlert}>
              <label>
                Execution Time
                <input
                  type="datetime-local"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  required
                />
              </label>

              <label>
                Title
                <input value={alertTitle} onChange={(e) => setAlertTitle(e.target.value)} required />
              </label>

              <label>
                Message
                <textarea value={alertMessage} onChange={(e) => setAlertMessage(e.target.value)} required />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label>
                  Duration
                  <span className="duration-field">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={durationValue}
                      onChange={(e) => setDurationValue(Math.max(1, Number(e.target.value)))}
                      required
                    />
                    <select value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}>
                      {DURATION_UNITS.map((u) => (
                        <option key={u.key} value={u.key}>{u.label}</option>
                      ))}
                    </select>
                  </span>
                  <small className="duration-hint">
                    Stays up for {formatDurationLabel(alertDuration)} — the event timer keeps running underneath.
                  </small>
                </label>
                <label>
                  Type
                  <select value={alertType} onChange={(e) => setAlertType(e.target.value as AlertType)}>
                    <option value="INFO">INFO</option>
                    <option value="WARNING">WARNING</option>
                    <option value="ALERT">ALERT</option>
                    <option value="URGENT">URGENT</option>
                  </select>
                </label>
              </div>

              <label>
                Target Audience
                <select value={alertTarget} onChange={(e) => setAlertTarget(e.target.value)}>
                  <option value={ALL_DISPLAYS_TARGET}>{ALL_DISPLAYS_TARGET}</option>
                  {rooms.length > 0 && (
                    <optgroup label="Rooms">
                      {rooms.map((r) => (
                        <option key={r.id} value={roomTarget(r.id)}>
                          ROOM: {r.code} — {r.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Batches">
                    {batches.map((b) => (
                      <option key={b.id} value={batchTarget(b.name)}>
                        BATCH: {b.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Individual devices">
                    {displays.map((d) => (
                      <option key={d.id} value={nodeTarget(d.display_id)}>
                        {d.display_id} — {d.display_name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>

              <div className="modal-target">
                <span>Target:</span>
                <strong>{describeTarget(alertTarget, roomNames)}</strong>
                <span className="target-online">
                  <i /> {targetReach.matched} matching screens
                </span>
              </div>

              {broadcastError && <div className="modal-error">{broadcastError}</div>}

              <button type="submit" className="primary-action modal-send" style={{ marginTop: 20 }}>
                <Calendar size={16} /> Add to Schedule Queue
              </button>
            </form>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: ADD DISPLAY NODE
         ===================================================================== */}
      {displayModalOpen && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setDisplayModalOpen(false)}>
              <X size={18} />
            </button>
            <span className="eyebrow">HARDWARE PROVISIONING</span>
            <h2>Register Display Node</h2>
            <p>Add a new kiosk or display monitor endpoint to the venue network.</p>

            <form onSubmit={handleCreateDisplay}>
              <label>
                Display Node Identifier (e.g. DISPLAY-04)
                <input
                  value={newDisplayId}
                  onChange={(e) => setNewDisplayId(e.target.value)}
                  placeholder="DISPLAY-04"
                  required
                />
              </label>

              <label>
                Display Friendly Name
                <input
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="e.g. Mech Lab Screen"
                  required
                />
              </label>

              <label>
                Physical Location
                <input
                  value={newDisplayLocation}
                  onChange={(e) => setNewDisplayLocation(e.target.value)}
                  placeholder="e.g. 2nd Floor Workshop"
                />
              </label>

              <label>
                Assigned Batch
                <select value={newDisplayBatch} onChange={(e) => setNewDisplayBatch(e.target.value)}>
                  <option value="ALL">ALL</option>
                  {batches.map((b) => (
                    <option key={b.id} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>

              <button type="submit" className="primary-action modal-send" style={{ marginTop: 20 }}>
                <Plus size={16} /> Register Node
              </button>
            </form>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: DISPLAY PAIRING CODE
         ===================================================================== */}
      {pairingInfo && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setPairingInfo(null)}>
              <X size={18} />
            </button>
            <span className="eyebrow">KIOSK PAIRING — {pairingInfo.displayId}</span>
            <h2>Enter this code on the display</h2>
            <p>
              Open <strong>/display</strong> on the kiosk and type the code. It works once and expires at{' '}
              {new Date(pairingInfo.expiresAt).toLocaleTimeString('en-IN', { hour12: false })}.
            </p>
            <div className="pairing-code">{pairingInfo.code.slice(0, 3)}-{pairingInfo.code.slice(3)}</div>
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>
              This code is shown only now. Close this and generate a new one if it expires.
            </p>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: SYSTEM SETTINGS & PIN CHANGE
         ===================================================================== */}
      {settingsModalOpen && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setSettingsModalOpen(false)}>
              <X size={18} />
            </button>
            <span className="eyebrow">SYSTEM CONFIGURATION</span>
            <h2>Control Center Settings</h2>
            <p>Manage event branding and operator security credentials.</p>

            <form onSubmit={handleSaveSettings} style={{ marginBottom: 24 }}>
              <label>
                Event Name
                <input value={eventName} onChange={(e) => setEventName(e.target.value)} required />
              </label>
              <label>
                Host Organization
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
              </label>
              <button type="submit" className="outline-action" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}>
                Update Event Info
              </button>
              {settingsError && <div className="login-error" style={{ marginTop: 10 }} role="alert">{settingsError}</div>}
              {settingsSaved && (
                <div role="status" style={{ color: 'var(--green)', fontSize: 11, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle2 size={14} /> {settingsSaved}
                </div>
              )}
            </form>

            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
              <span className="eyebrow">SECURITY / CHANGE YOUR PIN</span>
              <form onSubmit={handleUpdatePin}>
                <label>
                  Current PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={12}
                    value={currentPin}
                    onChange={(e) => setCurrentPin(e.target.value)}
                    placeholder="••••••"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label>
                  New PIN (6–12 digits)
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={12}
                    autoComplete="new-password"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                    placeholder="••••••"
                    required
                  />
                </label>
                <label>
                  Confirm New PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={12}
                    autoComplete="new-password"
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(e.target.value)}
                    placeholder="••••••"
                    required
                  />
                </label>

                {pinError && <div className="login-error" style={{ marginTop: 10 }}>{pinError}</div>}
                {pinSuccess && (
                  <div style={{ color: 'var(--green)', fontSize: 11, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle2 size={14} /> {pinSuccess}
                  </div>
                )}

                <button
                  type="submit"
                  className="primary-action"
                  style={{ marginTop: 14, width: '100%', justifyContent: 'center' }}
                >
                  Save New PIN
                </button>
              </form>
            </div>

            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 20 }}>
              <span className="eyebrow">SECURITY / SESSIONS</span>
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '8px 0 12px' }}>
                Signs out every admin, operator and participant on every device. You stay signed in here. Paired
                display screens keep running.
              </p>
              <button
                type="button"
                className="outline-action"
                onClick={handleEndAllSessions}
                disabled={endingSessions}
                style={{ width: '100%', justifyContent: 'center', color: '#ff7584', borderColor: 'rgba(239, 28, 47, 0.5)' }}
              >
                <KeyRound size={15} /> {endingSessions ? 'Ending sessions…' : 'End all other sessions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
