'use client';

import { useState } from 'react';
import { LifeBuoy, Send } from 'lucide-react';
import {
  categoryLabel,
  CATEGORY_OPTIONS,
  PRIORITY_OPTIONS,
  raiseIssue,
  replyToIssue,
  useIssues,
  type IssueCategory,
  type IssuePriority,
} from '@/lib/issues-api';

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const STATUS_COPY: Record<string, string> = {
  open: 'Sent — waiting for staff',
  acknowledged: 'Staff are on it',
  resolved: 'Resolved',
};

/** Raise an issue for your team and follow what happens to it. */
export function ParticipantIssues() {
  // A participant's own issue list: they get a reply within minutes, not
  // seconds, and this poll runs on every phone in the venue.
  const { issues, refetch } = useIssues(60000);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<IssueCategory>('technical');
  const [priority, setPriority] = useState<IssuePriority>('normal');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError('');
    const { error: apiError } = await raiseIssue({ category, priority, title, description });
    setSending(false);
    if (apiError) {
      setError(apiError.message);
      return;
    }
    setTitle('');
    setDescription('');
    setPriority('normal');
    setOpen(false);
    refetch();
  };

  const sendReply = async (issueId: string) => {
    const text = (replies[issueId] || '').trim();
    if (!text) return;
    const { error: apiError } = await replyToIssue(issueId, text);
    if (apiError) {
      setError(apiError.message);
      return;
    }
    setReplies({ ...replies, [issueId]: '' });
    refetch();
  };

  return (
    <section className="cyber-frame participant-issues">
      <div className="panel-heading" style={{ marginBottom: 12 }}>
        <div>
          <span className="eyebrow">NEED HELP?</span>
          <h2>Team issues</h2>
        </div>
        <LifeBuoy size={20} />
      </div>

      {!open && (
        <button className="primary-action" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setOpen(true)}>
          Raise an issue
        </button>
      )}

      {open && (
        <form className="issue-form" onSubmit={submit}>
          <div className="issue-form-row">
            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value as IssueCategory)}>
                {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
                {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          </div>
          {(priority === 'urgent' || category === 'medical') && (
            <p className="issue-urgent-note">
              {category === 'medical'
                ? 'For a medical emergency, also tell the nearest volunteer right away.'
                : 'Urgent alerts the core team with an alarm. Please use it only when it genuinely can’t wait.'}
            </p>
          )}
          <label className="field">
            <span>What&apos;s wrong?</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Projector not turning on" required />
          </label>
          <label className="field">
            <span>Details (optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} placeholder="Where exactly, what you tried…" />
          </label>
          {error && <div className="action-error"><span>{error}</span></div>}
          <div className="issue-form-actions">
            <button type="button" className="outline-action" onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
            <button type="submit" className="primary-action" disabled={sending || !title.trim()}>
              <Send size={14} /> {sending ? 'Sending…' : 'Send to event staff'}
            </button>
          </div>
        </form>
      )}

      {!open && error && <div className="action-error" style={{ marginTop: 10 }}><span>{error}</span></div>}

      <ul className="participant-issue-list">
        {issues.map((issue) => (
          <li key={issue.id} className={'participant-issue status-' + issue.status}>
            <div className="participant-issue-head">
              <strong>{issue.title}</strong>
              <span className={'issue-status-pill ' + issue.status}>{STATUS_COPY[issue.status]}</span>
            </div>
            <div className="participant-issue-meta">
              {categoryLabel(issue.category)} · {issue.priority} · {ago(issue.created_at)}
            </div>
            {issue.messages.length > 0 && (
              <ul className="issue-thread">
                {issue.messages.map((m) => (
                  <li key={m.id} className={m.author_role === 'participant' ? 'mine' : 'staff'}>
                    <span>{m.author_label}</span>
                    <p>{m.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {issue.status !== 'resolved' && (
              <div className="issue-reply">
                <input
                  value={replies[issue.id] || ''}
                  onChange={(e) => setReplies({ ...replies, [issue.id]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReply(issue.id); } }}
                  maxLength={1000}
                  placeholder="Add an update…"
                />
                <button className="inline-dismiss" onClick={() => sendReply(issue.id)} disabled={!(replies[issue.id] || '').trim()}>
                  Send
                </button>
              </div>
            )}
          </li>
        ))}
        {issues.length === 0 && <li className="panel-hint">Your team hasn&apos;t raised any issues.</li>}
      </ul>
    </section>
  );
}
