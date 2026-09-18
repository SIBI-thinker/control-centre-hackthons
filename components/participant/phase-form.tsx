'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CloudOff, Loader2, Lock, Save } from 'lucide-react';
import { api } from '@/lib/api';

export type PhaseFormField = {
  id: string;
  kind: 'text' | 'choice';
  label: string;
  help: string;
  required: boolean;
  max_length: number;
  options: { id: string; label: string; body: string }[];
  value: string;
  option_id: string | null;
  answered_by: string | null;
  updated_at: string | null;
};

type Answer = { value: string; option_id: string | null };

/** How long a problem statement can be before it is collapsed by default. */
const PREVIEW_CHARS = 260;

/**
 * Seconds left in the phase at which unsaved work is sent on its own.
 *
 * Saving is manual by design — 2000 participants typing into an autosaving
 * form would be a write per keystroke against a laptop. But answers lock the
 * moment the phase ends, so anything still unsaved as the window closes would
 * be lost. These are the safety nets, tried in order while there is still time
 * for the request to land.
 */
const AUTOSAVE_AT = [120, 60, 20];

function answersOf(fields: PhaseFormField[]): Record<string, Answer> {
  const map: Record<string, Answer> = {};
  fields.forEach((f) => (map[f.id] = { value: f.value, option_id: f.option_id }));
  return map;
}

function sameAnswers(a: Record<string, Answer>, b: Record<string, Answer>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => b[k] && a[k].value === b[k].value && a[k].option_id === b[k].option_id);
}

function agoLabel(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function PhaseForm({
  phaseId,
  fields,
  open,
  secondsLeft,
  me,
  serverNow,
  onSaved,
}: {
  phaseId: string;
  fields: PhaseFormField[];
  open: boolean;
  secondsLeft: number;
  me: string;
  serverNow: number;
  onSaved: () => void;
}) {
  const serverAnswers = useMemo(() => answersOf(fields), [fields]);
  const [answers, setAnswers] = useState<Record<string, Answer>>(serverAnswers);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [overwritten, setOverwritten] = useState(false);

  const dirty = !sameAnswers(answers, serverAnswers);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const answersRef = useRef(answers);
  answersRef.current = answers;

  // Adopt what the server has whenever there is nothing local to lose. While
  // there is, keep typing intact and just say a team-mate has saved since.
  const lastServerRef = useRef(serverAnswers);
  useEffect(() => {
    if (sameAnswers(lastServerRef.current, serverAnswers)) return;
    lastServerRef.current = serverAnswers;
    if (!dirtyRef.current) {
      setAnswers(serverAnswers);
      setOverwritten(false);
    } else {
      setOverwritten(true);
    }
  }, [serverAnswers]);

  // A new phase starts from its own answers.
  useEffect(() => {
    setAnswers(answersOf(fields));
    setSavedAt(null);
    setOverwritten(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseId]);

  const missing = fields.filter(
    (f) => f.required && (f.kind === 'choice' ? !answers[f.id]?.option_id : !answers[f.id]?.value.trim())
  );

  const save = useCallback(
    async (silent: boolean) => {
      if (!dirtyRef.current || !open) return;
      setSaving(true);
      if (!silent) setError('');
      const payload = fields.map((f) => ({
        field_id: f.id,
        value: answersRef.current[f.id]?.value ?? '',
        option_id: answersRef.current[f.id]?.option_id ?? null,
      }));
      const { data, error: apiError } = await api<{ saved_at: string }>('POST', '/api/participant/phase-form', {
        phase_id: phaseId,
        answers: payload,
      });
      setSaving(false);
      if (apiError) {
        setError(apiError.message);
        return;
      }
      setSavedAt(data?.saved_at ?? new Date().toISOString());
      setOverwritten(false);
      lastServerRef.current = { ...answersRef.current };
      onSaved();
    },
    [fields, open, phaseId, onSaved]
  );

  // Safety saves as the phase window closes.
  const firedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!open || !dirty) return;
    const mark = AUTOSAVE_AT.find((t) => secondsLeft <= t && !firedRef.current.has(t));
    if (mark === undefined) return;
    firedRef.current.add(mark);
    save(true);
  }, [secondsLeft, dirty, open, save]);

  useEffect(() => {
    firedRef.current = new Set();
  }, [phaseId]);

  // Closing the tab with unsaved work: warn, and make one best-effort send.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current || !open) return;
      try {
        const body = JSON.stringify({
          phase_id: phaseId,
          answers: fields.map((f) => ({
            field_id: f.id,
            value: answersRef.current[f.id]?.value ?? '',
            option_id: answersRef.current[f.id]?.option_id ?? null,
          })),
        });
        navigator.sendBeacon('/api/participant/phase-form', new Blob([body], { type: 'application/json' }));
      } catch {
        // Best effort only — the warning below is what actually protects them.
      }
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [fields, open, phaseId]);

  if (fields.length === 0) return null;

  const setAnswer = (fieldId: string, patch: Partial<Answer>) => {
    setAnswers((prev) => ({ ...prev, [fieldId]: { ...(prev[fieldId] ?? { value: '', option_id: null }), ...patch } }));
  };

  const lastSaved = savedAt || fields.reduce<string | null>((latest, f) => (f.updated_at && (!latest || f.updated_at > latest) ? f.updated_at : latest), null);
  const lastBy = fields.find((f) => f.updated_at === lastSaved)?.answered_by ?? null;

  return (
    <div className={open ? 'phase-form' : 'phase-form locked'}>
      <div className="phase-form-head">
        <span className="eyebrow">TEAM SUBMISSION</span>
        {open ? (
          <span className="phase-form-note">Shared with your team. Nothing is sent until you press Save.</span>
        ) : (
          <span className="phase-form-note locked-note"><Lock size={12} /> This phase has ended — answers are locked.</span>
        )}
      </div>

      {overwritten && (
        <div className="phase-form-warning">
          A team-mate saved while you were typing. Saving now replaces their version with what is on this screen.
        </div>
      )}

      {fields.map((field, index) => {
        const answer = answers[field.id] ?? { value: '', option_id: null };
        return (
          <div key={field.id} className="phase-form-field">
            <div className="phase-form-label">
              <span className="phase-form-num">{index + 1}</span>
              <h3>
                {field.label}
                {field.required && <b title="Required"> *</b>}
              </h3>
            </div>
            {field.help && <p className="phase-form-help">{field.help}</p>}

            {field.kind === 'choice' ? (
              <div className="statement-list">
                {field.options.map((option, optionIndex) => {
                  const picked = answer.option_id === option.id;
                  const long = option.body.length > PREVIEW_CHARS;
                  const showAll = picked || expanded[option.id];
                  return (
                    <div key={option.id} className={picked ? 'statement picked' : 'statement'}>
                      <button
                        type="button"
                        className="statement-pick"
                        disabled={!open}
                        onClick={() => setAnswer(field.id, { option_id: picked ? null : option.id, value: picked ? '' : option.label })}
                      >
                        <span className="statement-mark">{picked ? <Check size={14} /> : String.fromCharCode(65 + optionIndex)}</span>
                        <span className="statement-title">{option.label}</span>
                      </button>
                      {option.body && (
                        <>
                          <p className="statement-body">
                            {showAll || !long ? option.body : option.body.slice(0, PREVIEW_CHARS).trimEnd() + '…'}
                          </p>
                          {long && !picked && (
                            <button
                              type="button"
                              className="statement-more"
                              onClick={() => setExpanded((e) => ({ ...e, [option.id]: !e[option.id] }))}
                            >
                              {showAll ? <>Show less <ChevronUp size={13} /></> : <>Read the full statement <ChevronDown size={13} /></>}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <textarea
                  className="phase-form-input"
                  value={answer.value}
                  maxLength={field.max_length}
                  rows={6}
                  disabled={!open}
                  placeholder={open ? 'Type your answer here…' : ''}
                  onChange={(e) => setAnswer(field.id, { value: e.target.value })}
                />
                <div className="phase-form-count">
                  <span className={answer.value.length > field.max_length * 0.9 ? 'near-limit' : ''}>
                    {answer.value.length.toLocaleString('en-IN')} / {field.max_length.toLocaleString('en-IN')}
                  </span>
                </div>
              </>
            )}
          </div>
        );
      })}

      {open && (
        <div className={dirty ? 'phase-form-bar unsaved' : 'phase-form-bar'}>
          <div className="phase-form-status">
            {saving ? (
              <><Loader2 size={14} className="spin" /> Saving…</>
            ) : dirty ? (
              <><CloudOff size={14} /> Unsaved changes</>
            ) : lastSaved ? (
              <><Check size={14} /> Saved {agoLabel(lastSaved, serverNow)}{lastBy ? ' by ' + (lastBy === me ? 'you' : lastBy) : ''}</>
            ) : (
              <>Nothing saved yet</>
            )}
          </div>
          {missing.length > 0 && <span className="phase-form-missing">{missing.length} required answer{missing.length === 1 ? '' : 's'} still empty</span>}
          <button type="button" className="primary-action" onClick={() => save(false)} disabled={!dirty || saving}>
            <Save size={15} /> Save answers
          </button>
        </div>
      )}

      {error && <div className="phase-form-error">{error}</div>}
    </div>
  );
}
