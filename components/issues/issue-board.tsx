'use client';

import { useMemo, useState } from 'react';
import { CheckCheck, Eye, LifeBuoy, Plus, RotateCcw, Search, Send, Volume2, VolumeX, X } from 'lucide-react';
import { PushToggle } from '@/components/issues/push-toggle';
import {
  categoryLabel,
  CATEGORY_OPTIONS,
  PRIORITY_OPTIONS,
  raiseIssue,
  replyToIssue,
  setIssueStatus,
  type Issue,
  type IssueCategory,
  type IssuePriority,
  type IssueStatus,
} from '@/lib/issues-api';

type Filter = 'active' | 'open' | 'acknowledged' | 'resolved' | 'all';

const RANK: Record<string, number> = { urgent: 0, normal: 1, low: 2 };
const STATUS_RANK: Record<string, number> = { open: 0, acknowledged: 1, resolved: 2 };

function ago(iso: string, now: number) {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm ago';
  return new Date(iso).toLocaleString('en-IN');
}

/**
 * Issue queue for staff. The core team sees every room; an operator's list is
 * already limited to their rooms by the server.
 */
export function IssueBoard({
  issues,
  refetch,
  rooms,
  canRaiseWithoutRoom,
  soundOn,
  onToggleSound,
  now,
}: {
  issues: Issue[];
  refetch: () => void;
  rooms: { id: string; code: string; name: string }[];
  canRaiseWithoutRoom: boolean;
  soundOn: boolean;
  onToggleSound: () => void;
  now: number;
}) {
  const [filter, setFilter] = useState<Filter>('active');
  const [roomFilter, setRoomFilter] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [raising, setRaising] = useState(false);

  const counts = useMemo(
    () => ({
      open: issues.filter((i) => i.status === 'open').length,
      acknowledged: issues.filter((i) => i.status === 'acknowledged').length,
      resolved: issues.filter((i) => i.status === 'resolved').length,
    }),
    [issues]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return issues
      .filter((i) => {
        if (filter === 'active' && i.status === 'resolved') return false;
        if (filter !== 'active' && filter !== 'all' && i.status !== filter) return false;
        if (roomFilter && i.room_id !== roomFilter) return false;
        if (q && !(i.title + ' ' + i.description + ' ' + (i.team_name || '') + ' ' + i.raised_by_label).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          (a.status === 'resolved' ? 0 : RANK[a.priority] - RANK[b.priority]) ||
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
  }, [issues, filter, roomFilter, search]);

  const changeStatus = async (issue: Issue, status: IssueStatus) => {
    setBusyId(issue.id);
    const { error: apiError } = await setIssueStatus(issue.id, status);
    setBusyId(null);
    setError(apiError ? apiError.message : '');
    refetch();
  };

  const sendReply = async (issue: Issue) => {
    const text = (replies[issue.id] || '').trim();
    if (!text) return;
    const { error: apiError } = await replyToIssue(issue.id, text);
    if (apiError) {
      setError(apiError.message);
      return;
    }
    setReplies({ ...replies, [issue.id]: '' });
    refetch();
  };

  return (
    <div className="view-container">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">ISSUE QUEUE</span>
          <p>Raised by participants and room operators. Urgent issues keep sounding until someone acknowledges them.</p>
        </div>
        <div className="issue-top-actions">
          <button className="outline-action" onClick={onToggleSound} title="Sound for new issues on this device">
            {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />} {soundOn ? 'Sound on' : 'Sound off'}
          </button>
          <PushToggle />
          <button className="primary-action" onClick={() => setRaising(true)}>
            <Plus size={15} /> Raise issue
          </button>
        </div>
      </div>

      {error && (
        <div className="action-error">
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <div className="table-toolbar">
        <div className="segmented" style={{ margin: 0 }}>
          {(['active', 'open', 'acknowledged', 'resolved', 'all'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f}
              {f === 'active' && <b>{counts.open + counts.acknowledged}</b>}
              {(f === 'open' || f === 'acknowledged' || f === 'resolved') && <b>{counts[f]}</b>}
            </button>
          ))}
        </div>
        {rooms.length > 1 && (
          <select className="inline-batch-select" value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)}>
            <option value="">All rooms</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
          </select>
        )}
        <label className="search-field">
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search issues" />
        </label>
      </div>

      <div className="issue-list">
        {visible.map((issue) => (
          <article key={issue.id} className={'issue-card priority-' + issue.priority + ' status-' + issue.status}>
            <header className="issue-card-head">
              <div className="issue-card-title">
                <span className={'priority-badge ' + issue.priority}>{issue.priority.toUpperCase()}</span>
                <strong>{issue.title}</strong>
              </div>
              <span className={'issue-status-pill ' + issue.status}>{issue.status.toUpperCase()}</span>
            </header>

            <div className="issue-card-meta">
              <span>{categoryLabel(issue.category)}</span>
              <span>{issue.room_code || 'No room'}{issue.team_name ? ' · ' + issue.team_name : ''}</span>
              <span>{issue.raised_by_label}</span>
              <span>{ago(issue.created_at, now)}</span>
            </div>

            {issue.description && <p className="issue-card-desc">{issue.description}</p>}

            {(issue.acknowledged_by || issue.resolved_by) && (
              <div className="issue-card-trail">
                {issue.acknowledged_by && <span>Acknowledged by {issue.acknowledged_by} · {ago(issue.acknowledged_at!, now)}</span>}
                {issue.resolved_by && <span>Resolved by {issue.resolved_by} · {ago(issue.resolved_at!, now)}</span>}
              </div>
            )}

            {issue.messages.length > 0 && (
              <ul className="issue-thread">
                {issue.messages.map((m) => (
                  <li key={m.id} className={m.author_role === 'participant' ? 'participant' : 'staff'}>
                    <span>{m.author_label} · {ago(m.created_at, now)}</span>
                    <p>{m.body}</p>
                  </li>
                ))}
              </ul>
            )}

            <footer className="issue-card-actions">
              <div className="issue-reply">
                <input
                  value={replies[issue.id] || ''}
                  onChange={(e) => setReplies({ ...replies, [issue.id]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReply(issue); } }}
                  maxLength={1000}
                  placeholder={issue.raised_by_role === 'participant' ? 'Reply to the team…' : 'Add a note…'}
                />
                <button className="inline-dismiss" onClick={() => sendReply(issue)} disabled={!(replies[issue.id] || '').trim()}>
                  <Send size={11} />
                </button>
              </div>
              <span className="row-actions">
                {issue.status === 'open' && (
                  <button className="outline-action" disabled={busyId === issue.id} onClick={() => changeStatus(issue, 'acknowledged')}>
                    <Eye size={14} /> Acknowledge
                  </button>
                )}
                {issue.status !== 'resolved' && (
                  <button className="primary-action" disabled={busyId === issue.id} onClick={() => changeStatus(issue, 'resolved')}>
                    <CheckCheck size={14} /> Resolve
                  </button>
                )}
                {issue.status === 'resolved' && (
                  <button className="outline-action" disabled={busyId === issue.id} onClick={() => changeStatus(issue, 'open')}>
                    <RotateCcw size={14} /> Reopen
                  </button>
                )}
              </span>
            </footer>
          </article>
        ))}

        {visible.length === 0 && (
          <div className="issue-empty">
            <LifeBuoy size={22} />
            <p>{filter === 'active' ? 'No open issues. All quiet.' : 'No issues match.'}</p>
          </div>
        )}
      </div>

      {raising && (
        <RaiseIssueModal
          rooms={rooms}
          requireRoom={!canRaiseWithoutRoom}
          onClose={() => setRaising(false)}
          onRaised={() => {
            setRaising(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

function RaiseIssueModal({
  rooms,
  requireRoom,
  onClose,
  onRaised,
}: {
  rooms: { id: string; code: string; name: string }[];
  requireRoom: boolean;
  onClose: () => void;
  onRaised: () => void;
}) {
  const [roomId, setRoomId] = useState(rooms.length === 1 ? rooms[0].id : '');
  const [category, setCategory] = useState<IssueCategory>('technical');
  const [priority, setPriority] = useState<IssuePriority>('normal');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    const { error: apiError } = await raiseIssue({ category, priority, title, description, room_id: roomId || null });
    setSending(false);
    if (apiError) {
      setError(apiError.message);
      return;
    }
    onRaised();
  };

  return (
    <div className="modal-backdrop">
      <div className="alert-modal">
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <span className="eyebrow">RAISE ISSUE</span>
        <h2>Report a problem</h2>
        <form onSubmit={submit}>
          <label>
            Room
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)} required={requireRoom}>
              {!requireRoom && <option value="">Venue-wide / no specific room</option>}
              {requireRoom && rooms.length !== 1 && <option value="">Choose room…</option>}
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
            </select>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label>
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value as IssueCategory)}>
                {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label>
              Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
                {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Power strip failed at table 4" required />
          </label>
          <label>
            Details
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={4} />
          </label>
          {error && <div className="modal-error">{error}</div>}
          <button type="submit" className="primary-action modal-send" style={{ marginTop: 14 }} disabled={sending || !title.trim() || (requireRoom && !roomId)}>
            <Send size={15} /> {sending ? 'Sending…' : 'Raise issue'}
          </button>
        </form>
      </div>
    </div>
  );
}
