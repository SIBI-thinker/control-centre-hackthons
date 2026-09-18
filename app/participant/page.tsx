'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Clock3, DoorOpen, Hourglass, Users } from 'lucide-react';
import { PortalShell } from '@/components/portal/portal-shell';
import { ParticipantIssues } from '@/components/issues/participant-issues';
import { WifiCard, type ParticipantWifi } from '@/components/participant/wifi-card';
import { PhaseForm, type PhaseFormField } from '@/components/participant/phase-form';
import { api } from '@/lib/api';
import { useEventState } from '@/lib/hooks';
import { formatTime, getTimerUrgency } from '@/lib/supabase';

type ChecklistItem = { id: string; label: string; checked: boolean; checked_by: string | null; checked_at: string | null };

type Overview = {
  serverNow: number;
  me: { accountId: string; name: string };
  team: { id: string; name: string; code: string };
  room: { id: string; code: string; name: string } | null;
  teammates: { account_id: string; display_name: string }[];
  wifi: ParticipantWifi | null;
  currentPhase: {
    id: string;
    title: string;
    requirements: string;
    starts_at: string;
    ends_at: string;
    form_open: boolean;
    fields: PhaseFormField[];
    items: ChecklistItem[];
  } | null;
  nextPhase: { id: string; title: string; starts_at: string; ends_at: string } | null;
};

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function ParticipantPage() {
  const { state, remaining, now } = useEventState(20000);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const skewRef = useRef(0);

  const load = useCallback(async () => {
    const sentAt = Date.now();
    const { data, error: apiError } = await api<Overview>('GET', '/api/participant/overview');
    if (data) {
      skewRef.current = data.serverNow - (sentAt + Date.now()) / 2;
      setOverview(data);
      setError('');
    } else if (apiError) {
      setError(apiError.message);
    }
  }, []);

  useEffect(() => {
    load();
    // One laptop serves every participant: a page that reloads itself every
    // few seconds is what makes it fall over. The countdown runs locally, and
    // the page refetches on its own when the phase window closes.
    const interval = setInterval(load, 45000);
    return () => clearInterval(interval);
  }, [load]);

  // Server-corrected "now", so phase countdowns are right even on a device
  // with a wrong clock.
  const serverNow = now + skewRef.current;
  const phase = overview?.currentPhase ?? null;
  const phaseLeft = phase ? Math.max(0, Math.floor((new Date(phase.ends_at).getTime() - serverNow) / 1000)) : 0;

  // When the phase window ends, fetch straight away so the next phase appears.
  useEffect(() => {
    if (phase && phaseLeft === 0) load();
  }, [phase, phaseLeft, load]);

  const toggle = async (item: ChecklistItem) => {
    if (!overview || !phase || pending[item.id]) return;
    const nextChecked = !item.checked;
    setPending((p) => ({ ...p, [item.id]: true }));
    // Optimistic: flip immediately, roll back if the server refuses.
    setOverview({
      ...overview,
      currentPhase: {
        ...phase,
        items: phase.items.map((i) => (i.id === item.id ? { ...i, checked: nextChecked, checked_by: nextChecked ? overview.me.accountId : null } : i)),
      },
    });
    const { error: apiError } = await api('POST', '/api/participant/checklist', { item_id: item.id, checked: nextChecked });
    setPending((p) => ({ ...p, [item.id]: false }));
    if (apiError) setError(apiError.message);
    load();
  };

  const done = phase ? phase.items.filter((i) => i.checked).length : 0;
  const urgency = getTimerUrgency(remaining);

  return (
    <PortalShell roleLabel="PARTICIPANT" subtitle={overview ? overview.team.name : null}>
      {error && <div className="action-error"><span>{error}</span></div>}

      <section className={'participant-timer urgency-' + urgency}>
        <span className="eyebrow">HACKATHON TIME REMAINING</span>
        <strong>{state ? formatTime(remaining) : '--:--:--'}</strong>
        <span className="participant-timer-status">{state ? state.timer_status.replace('_', ' ') : 'CONNECTING'}</span>
      </section>

      {overview && (
        <div className="participant-meta">
          <span><Users size={14} /> {overview.team.name} <small>{overview.team.code}</small></span>
          <span><DoorOpen size={14} /> {overview.room ? overview.room.code + ' · ' + overview.room.name : 'No room assigned yet'}</span>
        </div>
      )}

      <div className="participant-grid">
        <section className="cyber-frame participant-phase">
          {!overview && <p className="panel-hint">Loading your phase…</p>}

          {overview && !overview.room && (
            <div className="phase-empty">
              <DoorOpen size={22} />
              <p>Your team hasn&apos;t been placed in a room yet, so there&apos;s no phase to show. Ask a volunteer or raise an issue below.</p>
            </div>
          )}

          {overview && overview.room && !phase && (
            <div className="phase-empty">
              <Hourglass size={22} />
              {overview.nextPhase ? (
                <p>
                  No phase is running in {overview.room.code} right now. Next up: <strong>{overview.nextPhase.title}</strong> at{' '}
                  {clock(overview.nextPhase.starts_at)}.
                </p>
              ) : (
                <p>No phase is running in {overview.room.code} right now.</p>
              )}
            </div>
          )}

          {phase && (
            <>
              <div className="phase-head">
                <div>
                  <span className="eyebrow">CURRENT PHASE · {clock(phase.starts_at)}–{clock(phase.ends_at)}</span>
                  <h2>{phase.title}</h2>
                </div>
                <div className="phase-countdown">
                  <Clock3 size={14} />
                  <strong>{formatTime(phaseLeft)}</strong>
                  <span>left in phase</span>
                </div>
              </div>

              {phase.requirements ? (
                <div className="phase-requirements">{phase.requirements}</div>
              ) : (
                <p className="panel-hint">No written requirements for this phase.</p>
              )}

              {phase.fields && phase.fields.length > 0 && (
                <PhaseForm
                  phaseId={phase.id}
                  fields={phase.fields}
                  open={phase.form_open && phaseLeft > 0}
                  secondsLeft={phaseLeft}
                  me={overview?.me.accountId || ''}
                  serverNow={serverNow}
                  onSaved={load}
                />
              )}

              {phase.items.length > 0 && (
                <div className="participant-checklist">
                  <div className="checklist-head">
                    <span className="eyebrow">TEAM CHECKLIST</span>
                    <span>{done}/{phase.items.length} done</span>
                  </div>
                  <div className="progress-bar"><i style={{ width: Math.round((done / phase.items.length) * 100) + '%' }} className={done === phase.items.length ? 'complete' : ''} /></div>
                  <ul>
                    {phase.items.map((item) => (
                      <li key={item.id}>
                        <button className={item.checked ? 'check-item done' : 'check-item'} onClick={() => toggle(item)} disabled={Boolean(pending[item.id])}>
                          {item.checked ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                          <span className="check-label">{item.label}</span>
                          {item.checked && item.checked_by && <small>{item.checked_by === overview?.me.accountId ? 'you' : item.checked_by}</small>}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="panel-hint">Ticks are shared with your whole team.</p>
                </div>
              )}

              {overview?.nextPhase && (
                <p className="panel-hint">Next: {overview.nextPhase.title} at {clock(overview.nextPhase.starts_at)}</p>
              )}
            </>
          )}
        </section>

        <aside className="participant-side">
          <WifiCard wifi={overview ? overview.wifi : null} />
          {overview && (
            <section className="cyber-frame">
              <span className="eyebrow">YOUR TEAM</span>
              <ul className="teammates">
                {overview.teammates.map((t) => (
                  <li key={t.account_id}>
                    <span>{t.display_name}</span>
                    <small>{t.account_id === overview.me.accountId ? 'you' : t.account_id}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ParticipantIssues />
        </aside>
      </div>
    </PortalShell>
  );
}
