'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarRange, ChevronDown, ChevronRight, Download, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { deletePhase, savePhase, usePhases, useRooms, type AdminPhase } from '@/lib/admin-api';
import { duplicateTeamNames, teamLabel } from '@/lib/teams';
import { PhaseFormEditor, type DraftField } from '@/components/admin/phase-form-editor';
import { downloadFromApi } from '@/lib/download';

type DraftItem = { key: string; id?: string; label: string };
type Draft = {
  id?: string;
  title: string;
  requirements: string;
  starts: string;
  ends: string;
  roomIds: string[];
  items: DraftItem[];
  fields: DraftField[];
};

/** ISO → value for <input type="datetime-local"> in the browser's timezone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatWindow(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const time = (d: Date) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return day(start) + ' ' + time(start) + ' → ' + (day(start) === day(end) ? '' : day(end) + ' ') + time(end);
}

let keySeq = 0;
const newKey = () => 'k' + ++keySeq;

function emptyDraft(): Draft {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return {
    title: '',
    requirements: '',
    starts: toLocalInput(start.toISOString()),
    ends: toLocalInput(end.toISOString()),
    roomIds: [],
    items: [],
    fields: [],
  };
}

function draftFrom(phase: AdminPhase): Draft {
  return {
    id: phase.id,
    title: phase.title,
    requirements: phase.requirements,
    starts: toLocalInput(phase.starts_at),
    ends: toLocalInput(phase.ends_at),
    roomIds: phase.room_ids.slice(),
    items: phase.items.map((i) => ({ key: newKey(), id: i.id, label: i.label })),
    fields: (phase.fields ?? []).map((f) => ({
      key: newKey(),
      id: f.id,
      kind: f.kind,
      label: f.label,
      help: f.help,
      required: f.required,
      maxLength: f.max_length,
      options: f.options.map((o) => ({ key: newKey(), id: o.id, label: o.label, body: o.body })),
    })),
  };
}

export function PhasesPanel({ now }: { now: number }) {
  const { phases, error, refetch } = usePhases();
  const { rooms } = useRooms();
  // Each team once across all phases, so a team in two phases isn't mistaken
  // for two teams sharing a name.
  const dupTeamNames = useMemo(() => {
    const byId = new Map<string, { code: string; name: string }>();
    phases.forEach((p) => p.team_progress.forEach((t) => byId.set(t.team_id, t)));
    return duplicateTeamNames(Array.from(byId.values()));
  }, [phases]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Which venue each phase's export is narrowed to ('' = every venue it runs in).
  const [exportVenue, setExportVenue] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<string | null>(null);

  const handleExport = async (phase: AdminPhase) => {
    setActionError('');
    setExporting(phase.id);
    const venue = exportVenue[phase.id] || '';
    const message = await downloadFromApi(
      '/api/admin/phases/' + phase.id + '/responses' + (venue ? '?room_id=' + encodeURIComponent(venue) : '')
    );
    setExporting(null);
    if (message) setActionError(message);
  };

  const roomCode = useMemo(() => {
    const map: Record<string, string> = {};
    rooms.forEach((r) => (map[r.id] = r.code));
    return map;
  }, [rooms]);

  const statusOf = (p: AdminPhase) => {
    const start = new Date(p.starts_at).getTime();
    const end = new Date(p.ends_at).getTime();
    if (now >= end) return 'ended';
    if (now >= start) return 'live';
    return 'upcoming';
  };

  // Rooms with no phase covering "now" — easy to miss while scheduling.
  const idleRooms = rooms.filter(
    (r) => !phases.some((p) => statusOf(p) === 'live' && p.room_ids.indexOf(r.id) !== -1)
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setFormError('');
    if (draft.roomIds.length === 0) {
      setFormError('Choose at least one room.');
      return;
    }
    setSaving(true);
    const { error: saveError } = await savePhase({
      id: draft.id,
      title: draft.title,
      requirements: draft.requirements,
      starts_at: new Date(draft.starts).toISOString(),
      ends_at: new Date(draft.ends).toISOString(),
      room_ids: draft.roomIds,
      items: draft.items.map((i) => ({ id: i.id, label: i.label })),
      fields: draft.fields.map((f) => ({
        id: f.id,
        kind: f.kind,
        label: f.label,
        help: f.help,
        required: f.required,
        max_length: f.maxLength,
        options: f.options.map((o) => ({ id: o.id, label: o.label, body: o.body })),
      })),
    });
    setSaving(false);
    if (saveError) {
      setFormError(saveError.message);
      return;
    }
    setDraft(null);
    refetch();
  };

  const handleDelete = async (phase: AdminPhase) => {
    const ticked = phase.team_progress.reduce((sum, t) => sum + t.done, 0);
    if (!confirm('Delete phase “' + phase.title + '”?' + (ticked ? '\n\n' + ticked + ' checklist tick(s) by teams will be lost.' : ''))) return;
    const { error: deleteError } = await deletePhase(phase.id);
    setActionError(deleteError ? deleteError.message : '');
    refetch();
  };

  const moveItem = (index: number, delta: number) => {
    if (!draft) return;
    const target = index + delta;
    if (target < 0 || target >= draft.items.length) return;
    const items = draft.items.slice();
    const [moved] = items.splice(index, 1);
    items.splice(target, 0, moved);
    setDraft({ ...draft, items });
  };

  return (
    <div className="view-container">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">EVENT PHASES</span>
          <p>
            Each phase runs in the rooms you pick. Participants see the current phase&apos;s requirements and checklist on
            their own page — display screens only ever show the timer and alerts.
          </p>
        </div>
        <button className="primary-action" onClick={() => { setFormError(''); setDraft(emptyDraft()); }}>
          <Plus size={16} /> New phase
        </button>
      </div>

      {(actionError || error) && <div className="action-error"><span>{actionError || error}</span></div>}

      {rooms.length > 0 && idleRooms.length > 0 && phases.length > 0 && (
        <p className="panel-hint" style={{ marginTop: 0 }}>
          No live phase right now in: {idleRooms.map((r) => r.code).join(', ')}
        </p>
      )}

      <section className="cyber-frame">
        <div className="cyber-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th></th>
                <th>PHASE</th>
                <th>WINDOW</th>
                <th>ROOMS</th>
                <th>CHECKLIST</th>
                <th>FORM</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {phases.map((p) => {
                const status = statusOf(p);
                const open = expanded === p.id;
                return [
                  <tr key={p.id}>
                    <td>
                      <button className="icon-danger" onClick={() => setExpanded(open ? null : p.id)} aria-label="Show team progress">
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td><strong style={{ color: 'var(--white)' }}>{p.title}</strong></td>
                    <td>{formatWindow(p.starts_at, p.ends_at)}</td>
                    <td>{p.room_ids.map((id) => roomCode[id]).filter(Boolean).join(', ') || '—'}</td>
                    <td>{p.items.length} item{p.items.length === 1 ? '' : 's'}</td>
                    <td>{(p.fields ?? []).length === 0 ? '—' : (p.fields ?? []).length + ' question' + ((p.fields ?? []).length === 1 ? '' : 's')}</td>
                    <td><span className={'phase-status ' + status}>{status.toUpperCase()}</span></td>
                    <td>
                      <span className="row-actions">
                        <button className="inline-dismiss" onClick={() => { setFormError(''); setDraft(draftFrom(p)); }} title="Edit phase">
                          <Pencil size={12} />
                        </button>
                        <button className="icon-danger" onClick={() => handleDelete(p)} title="Delete phase">
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>,
                  open && (
                    <tr key={p.id + '-progress'} className="phase-progress-row">
                      <td></td>
                      <td colSpan={7}>
                        {(p.fields ?? []).length > 0 && (
                          <div className="phase-export">
                            <span className="eyebrow">EXPORT ANSWERS</span>
                            <select
                              value={exportVenue[p.id] || ''}
                              onChange={(e) => setExportVenue({ ...exportVenue, [p.id]: e.target.value })}
                              className="inline-batch-select"
                            >
                              <option value="">All venues in this phase</option>
                              {p.room_ids.map((id) => (
                                <option key={id} value={id}>{roomCode[id] || 'room'}</option>
                              ))}
                            </select>
                            <button className="outline-action" onClick={() => handleExport(p)} disabled={exporting === p.id}>
                              <Download size={15} /> {exporting === p.id ? 'Preparing…' : 'Download CSV'}
                            </button>
                            <span className="panel-hint" style={{ margin: 0 }}>
                              One row per team, one column per question.
                            </span>
                          </div>
                        )}
                        {p.items.length === 0 ? (
                          <span className="panel-hint">This phase has no checklist.</span>
                        ) : p.team_progress.length === 0 ? (
                          <span className="panel-hint">No teams are in this phase&apos;s rooms yet.</span>
                        ) : (
                          <div className="progress-grid">
                            {p.team_progress.map((t) => {
                              const pct = Math.round((t.done / p.items.length) * 100);
                              return (
                                <div key={t.team_id} className="progress-cell">
                                  <div className="progress-cell-head">
                                    <strong>{teamLabel(t, dupTeamNames)}</strong>
                                    <span>{roomCode[t.room_id]} · {t.done}/{p.items.length}</span>
                                  </div>
                                  <div className="progress-bar"><i style={{ width: pct + '%' }} className={pct === 100 ? 'complete' : ''} /></div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
              {phases.length === 0 && (
                <tr><td colSpan={8} className="empty-cell">No phases yet. Create one — e.g. “Problem statement”, then “Solution build”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {draft && (
        <div className="modal-backdrop">
          <div className="alert-modal phase-modal">
            <button className="modal-close" onClick={() => setDraft(null)}><X size={18} /></button>
            <span className="eyebrow">{draft.id ? 'EDIT PHASE' : 'NEW PHASE'}</span>
            <h2>{draft.title || 'Untitled phase'}</h2>

            <form onSubmit={handleSave}>
              <label>
                Title
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} placeholder="Problem statement" required />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label>
                  Starts
                  <input type="datetime-local" value={draft.starts} onChange={(e) => setDraft({ ...draft, starts: e.target.value })} required />
                </label>
                <label>
                  Ends
                  <input type="datetime-local" value={draft.ends} onChange={(e) => setDraft({ ...draft, ends: e.target.value })} required />
                </label>
              </div>

              <div className="phase-field">
                <div className="phase-field-head">
                  <span><CalendarRange size={13} /> Rooms</span>
                  <span className="row-actions">
                    <button type="button" className="inline-dismiss" onClick={() => setDraft({ ...draft, roomIds: rooms.map((r) => r.id) })}>All</button>
                    <button type="button" className="inline-dismiss" onClick={() => setDraft({ ...draft, roomIds: [] })}>None</button>
                  </span>
                </div>
                <div className="room-chips">
                  {rooms.length === 0 && <span className="panel-hint">Create rooms first.</span>}
                  {rooms.map((r) => {
                    const on = draft.roomIds.indexOf(r.id) !== -1;
                    return (
                      <button
                        type="button"
                        key={r.id}
                        className={on ? 'chip on' : 'chip'}
                        onClick={() => setDraft({ ...draft, roomIds: on ? draft.roomIds.filter((x) => x !== r.id) : draft.roomIds.concat(r.id) })}
                      >
                        {r.code}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label>
                Requirements
                <textarea
                  value={draft.requirements}
                  onChange={(e) => setDraft({ ...draft, requirements: e.target.value })}
                  rows={6}
                  maxLength={5000}
                  placeholder={'What teams must do in this phase.\n\nLine breaks are kept as written.'}
                />
              </label>

              <div className="phase-field">
                <div className="phase-field-head">
                  <span><ListChecks size={13} /> Checklist</span>
                  <button type="button" className="inline-dismiss" onClick={() => setDraft({ ...draft, items: draft.items.concat({ key: newKey(), label: '' }) })}>
                    <Plus size={11} /> Add item
                  </button>
                </div>
                {draft.items.length === 0 && <span className="panel-hint">Optional. Teams tick these off; you see who is behind.</span>}
                {draft.items.map((item, index) => (
                  <div key={item.key} className="checklist-edit-row">
                    <span className="checklist-edit-num">{index + 1}</span>
                    <input
                      value={item.label}
                      maxLength={200}
                      placeholder="e.g. Problem statement submitted to judges"
                      onChange={(e) => {
                        const items = draft.items.slice();
                        items[index] = { ...item, label: e.target.value };
                        setDraft({ ...draft, items });
                      }}
                    />
                    <button type="button" className="icon-danger" onClick={() => moveItem(index, -1)} disabled={index === 0} aria-label="Move up"><ArrowUp size={13} /></button>
                    <button type="button" className="icon-danger" onClick={() => moveItem(index, 1)} disabled={index === draft.items.length - 1} aria-label="Move down"><ArrowDown size={13} /></button>
                    <button
                      type="button"
                      className="icon-danger"
                      aria-label="Remove item"
                      onClick={() => {
                        if (item.id && !confirm('Remove this item? Any team ticks on it are deleted.')) return;
                        setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                {draft.id && draft.items.some((i) => i.id) && (
                  <span className="panel-hint">Editing an item&apos;s wording keeps the ticks teams already made on it.</span>
                )}
              </div>

              <PhaseFormEditor
                fields={draft.fields}
                onChange={(fields) => setDraft({ ...draft, fields })}
                newKey={newKey}
                editingExisting={Boolean(draft.id)}
              />

              {formError && <div className="modal-error">{formError}</div>}

              <button type="submit" className="primary-action modal-send" style={{ marginTop: 16 }} disabled={saving}>
                {saving ? 'Saving…' : draft.id ? 'Save phase' : 'Create phase'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
