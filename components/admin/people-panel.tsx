'use client';

import { useMemo, useState } from 'react';
import { Download, FileUp, KeyRound, Plus, Search, Trash2, Upload, UserPlus, Users, X } from 'lucide-react';
import {
  createAccount,
  createTeam,
  deleteAccount,
  deleteTeam,
  importAccounts,
  resetAccountPin,
  resetTeamPins,
  updateAccount,
  updateTeam,
  useAccounts,
  useRooms,
  useTeams,
  type ImportResult,
} from '@/lib/admin-api';
import { CredentialsSheet } from '@/components/admin/credentials-sheet';
import type { AccountSummary, IssuedCredential, Role } from '@/lib/supabase';
import { brandSlug } from '@/lib/brand';
import { duplicateTeamNames, teamLabel } from '@/lib/teams';
import { downloadCsv, fileStamp } from '@/lib/download';
import { useBrand } from '@/lib/hooks';

type Tab = 'teams' | 'participant' | 'operator' | 'admin' | 'import';

const TABS: { key: Tab; label: string }[] = [
  { key: 'teams', label: 'Teams' },
  { key: 'participant', label: 'Participants' },
  { key: 'operator', label: 'Room operators' },
  { key: 'admin', label: 'Core team' },
  { key: 'import', label: 'Import CSV' },
];

const PARTICIPANT_TEMPLATE = 'name,team,room,id\nAsha Raman,Byte Me,F101,\nKarthik S,Byte Me,F101,21CS045\n';
const OPERATOR_TEMPLATE = 'name,rooms,id\nPriya N,F101|F102,\nArun K,AIML-A,OP-ARUN\n';

function timeAgo(iso: string | null) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return new Date(iso).toLocaleDateString('en-IN');
}

export function PeoplePanel({ currentAccountId }: { currentAccountId: string | null }) {
  const [tab, setTab] = useState<Tab>('teams');
  const brand = useBrand();
  const { rooms, refetch: refetchRooms } = useRooms();
  const { teams, refetch: refetchTeams } = useTeams();
  const { accounts, refetch: refetchAccounts } = useAccounts();

  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<{ title: string; credentials: IssuedCredential[] } | null>(null);

  const roomLabel = useMemo(() => {
    const map: Record<string, string> = {};
    rooms.forEach((r) => (map[r.id] = r.code));
    return map;
  }, [rooms]);
  const teamById = useMemo(() => {
    const map: Record<string, (typeof teams)[number]> = {};
    teams.forEach((t) => (map[t.id] = t));
    return map;
  }, [teams]);

  const refreshAll = async () => {
    await Promise.all([refetchTeams(), refetchAccounts(), refetchRooms()]);
  };

  const run = async <T,>(fn: () => Promise<{ data: T | null; error: { message: string } | null }>) => {
    setBusy(true);
    const result = await fn();
    setBusy(false);
    setActionError(result.error ? result.error.message : '');
    if (!result.error) await refreshAll();
    return result;
  };

  const counts = {
    participant: accounts.filter((a) => a.role === 'participant').length,
    operator: accounts.filter((a) => a.role === 'operator').length,
    admin: accounts.filter((a) => a.role === 'admin').length,
  };

  return (
    <div className="view-container">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">PEOPLE & ACCESS</span>
          <p>Everyone signs in with a personal ID and PIN. PINs are shown once, when created or reset.</p>
        </div>
      </div>

      <div className="segmented" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'teams' && <b>{teams.length}</b>}
            {(t.key === 'participant' || t.key === 'operator' || t.key === 'admin') && <b>{counts[t.key]}</b>}
          </button>
        ))}
      </div>

      {actionError && (
        <div className="action-error" role="alert">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {tab === 'teams' && (
        <TeamsTab
          teams={teams}
          rooms={rooms}
          roomLabel={roomLabel}
          participants={accounts.filter((a) => a.role === 'participant')}
          eventName={brand.name}
          busy={busy}
          onCreate={(input) => run(() => createTeam(input))}
          onChangeRoom={(id, roomId) => run(() => updateTeam(id, { room_id: roomId }))}
          onDelete={(id) => run(() => deleteTeam(id))}
          onResetPins={async (id, name) => {
            const result = await run(() => resetTeamPins(id));
            if (result.data) setSheet({ title: 'New PINs — ' + name, credentials: result.data.credentials });
          }}
        />
      )}

      {(tab === 'participant' || tab === 'operator' || tab === 'admin') && (
        <AccountsTab
          role={tab}
          accounts={accounts.filter((a) => a.role === tab)}
          teams={teams}
          rooms={rooms}
          roomLabel={roomLabel}
          teamById={teamById}
          currentAccountId={currentAccountId}
          busy={busy}
          onCreate={async (input) => {
            const result = await run(() => createAccount(input));
            if (result.data) setSheet({ title: 'New account — ' + result.data.credential.account_id, credentials: [result.data.credential] });
            return Boolean(result.data);
          }}
          onUpdate={(id, updates) => run(() => updateAccount(id, updates))}
          onDelete={(id) => run(() => deleteAccount(id))}
          onResetPin={async (id) => {
            const result = await run(() => resetAccountPin(id));
            if (result.data) setSheet({ title: 'New PIN — ' + result.data.credential.account_id, credentials: [result.data.credential] });
          }}
        />
      )}

      {tab === 'import' && (
        <ImportTab
          onImported={async (credentials, kind) => {
            await refreshAll();
            setSheet({ title: 'Imported ' + credentials.length + ' ' + kind, credentials });
          }}
        />
      )}

      {sheet && <CredentialsSheet title={sheet.title} credentials={sheet.credentials} onClose={() => setSheet(null)} />}
    </div>
  );
}

// ============================================================================
// Teams
// ============================================================================
function TeamsTab({
  teams,
  rooms,
  roomLabel,
  participants,
  eventName,
  busy,
  onCreate,
  onChangeRoom,
  onDelete,
  onResetPins,
}: {
  teams: ReturnType<typeof useTeams>['teams'];
  rooms: ReturnType<typeof useRooms>['rooms'];
  roomLabel: Record<string, string>;
  participants: AccountSummary[];
  eventName: string;
  busy: boolean;
  onCreate: (input: { name: string; room_id: string | null; code?: string }) => Promise<{ error: unknown }>;
  onChangeRoom: (id: string, roomId: string | null) => void;
  onDelete: (id: string) => void;
  onResetPins: (id: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [roomId, setRoomId] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await onCreate({ name, room_id: roomId || null, code: code || undefined });
    if (!result.error) {
      setName('');
      setCode('');
    }
  };

  // Venue filter — 'ALL', 'NONE' (teams not placed in a room yet), or a room id.
  const [venue, setVenue] = useState('ALL');
  const [search, setSearch] = useState('');

  const roomById = useMemo(() => {
    const map: Record<string, (typeof rooms)[number]> = {};
    rooms.forEach((r) => (map[r.id] = r));
    return map;
  }, [rooms]);

  const membersByTeam = useMemo(() => {
    const map: Record<string, AccountSummary[]> = {};
    participants.forEach((p) => {
      if (!p.team_id) return;
      (map[p.team_id] = map[p.team_id] || []).push(p);
    });
    return map;
  }, [participants]);

  const visibleTeams = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return teams.filter((t) => {
      if (venue === 'NONE' ? Boolean(t.room_id) : venue !== 'ALL' && t.room_id !== venue) return false;
      if (!needle) return true;
      return t.name.toLowerCase().includes(needle) || t.code.toLowerCase().includes(needle);
    });
  }, [teams, venue, search]);

  const venueName = venue === 'ALL' ? 'all venues' : venue === 'NONE' ? 'no venue' : roomById[venue]?.code || 'venue';

  // The export is exactly what the table shows, so what you filter is what you
  // get — no second, invisible notion of "selected".
  const exportName = (kind: string) =>
    brandSlug(eventName) + '-' + kind + '-' + brandSlug(venueName) + '-' + fileStamp() + '.csv';

  const exportTeams = () => {
    const rows = [['team_code', 'team_name', 'venue_code', 'venue_name', 'venue_location', 'members']].concat(
      visibleTeams.map((t) => {
        const room = t.room_id ? roomById[t.room_id] : null;
        return [t.code, t.name, room?.code || '', room?.name || '', room?.location || '', String(t.member_count)];
      })
    );
    downloadCsv(exportName('teams'), rows);
  };

  const exportMembers = () => {
    const rows: string[][] = [['team_code', 'team_name', 'venue_code', 'venue_name', 'participant_id', 'participant_name', 'status']];
    visibleTeams.forEach((t) => {
      const room = t.room_id ? roomById[t.room_id] : null;
      const members = (membersByTeam[t.id] || []).slice().sort((a, b) => a.account_id.localeCompare(b.account_id));
      if (members.length === 0) {
        // Keep the team in the sheet — an empty team is worth seeing.
        rows.push([t.code, t.name, room?.code || '', room?.name || '', '', '', 'no members']);
        return;
      }
      members.forEach((m) => {
        rows.push([t.code, t.name, room?.code || '', room?.name || '', m.account_id, m.display_name, m.active ? 'active' : 'disabled']);
      });
    });
    downloadCsv(exportName('team-members'), rows);
  };

  const exportedRows = visibleTeams.reduce((total, t) => total + Math.max(1, (membersByTeam[t.id] || []).length), 0);

  return (
    <>
      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">NEW TEAM</span>
            <h2>Add a team</h2>
          </div>
          <Users size={20} />
        </div>
        <form className="inline-form" onSubmit={handleCreate}>
          <label className="field field-wide">
            <span>Team name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Byte Me" maxLength={80} required />
          </label>
          <label className="field">
            <span>Room</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">No room yet</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.code} — {r.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Code (optional)</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="auto: T-001" maxLength={40} />
          </label>
          <button type="submit" className="primary-action" disabled={busy || !name.trim()}>
            <Plus size={15} /> Add team
          </button>
        </form>
      </section>

      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{visibleTeams.length} OF {teams.length} TEAMS</span>
            <h2>Team directory</h2>
          </div>
          <span className="row-actions">
            <button className="outline-action" onClick={exportTeams} disabled={visibleTeams.length === 0} title="Download the teams listed below">
              <Download size={15} /> Export teams
            </button>
            <button className="outline-action" onClick={exportMembers} disabled={visibleTeams.length === 0} title="Download every member of the teams listed below">
              <Download size={15} /> Export members
            </button>
          </span>
        </div>

        <form className="inline-form" onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            <span>Venue</span>
            <select value={venue} onChange={(e) => setVenue(e.target.value)}>
              <option value="ALL">All venues</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.code} — {r.name}</option>
              ))}
              <option value="NONE">No room assigned</option>
            </select>
          </label>
          <label className="field field-wide">
            <span>Search</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Team name or code" />
          </label>
          {(venue !== 'ALL' || search.trim()) && (
            <button type="button" className="outline-action" onClick={() => { setVenue('ALL'); setSearch(''); }}>
              <X size={14} /> Clear filter
            </button>
          )}
        </form>
        <p className="panel-hint">
          Exports follow this filter: {visibleTeams.length} team{visibleTeams.length === 1 ? '' : 's'} ({venueName}), {exportedRows} row
          {exportedRows === 1 ? '' : 's'} in the members sheet.
        </p>

        <div className="cyber-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th>CODE</th>
                <th>TEAM</th>
                <th>ROOM</th>
                <th>MEMBERS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {visibleTeams.map((t) => (
                <tr key={t.id}>
                  <td><strong style={{ color: 'var(--white)' }}>{t.code}</strong></td>
                  <td>{t.name}</td>
                  <td>
                    <select className="inline-batch-select" value={t.room_id || ''} onChange={(e) => onChangeRoom(t.id, e.target.value || null)}>
                      <option value="">— none —</option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>{r.code}</option>
                      ))}
                    </select>
                  </td>
                  <td>{t.member_count}</td>
                  <td>
                    <span className="row-actions">
                      <button
                        className="inline-dismiss"
                        disabled={busy || t.member_count === 0}
                        onClick={() => {
                          if (confirm('Issue new PINs for all ' + t.member_count + ' members of ' + t.name + '? They will be signed out and old PINs stop working.')) onResetPins(t.id, t.name);
                        }}
                        title="Reset every member's PIN and print a new sheet"
                      >
                        <KeyRound size={12} /> New PINs
                      </button>
                      <button
                        className="icon-danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm('Delete team ' + t.name + '?')) onDelete(t.id);
                        }}
                        title={t.member_count ? 'Move or delete members first' : 'Delete team'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {visibleTeams.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    {teams.length === 0
                      ? 'No teams yet. Add one above, or import participants — teams are created automatically.'
                      : 'No team matches this filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {teams.some((t) => !t.room_id) && (
          <p className="panel-hint">Teams without a room won&apos;t see any phase until they&apos;re assigned one.</p>
        )}
        {Object.keys(roomLabel).length === 0 && <p className="panel-hint">Tip: create rooms first so teams can be placed in them.</p>}
      </section>
    </>
  );
}

// ============================================================================
// Accounts (participants / operators / core team)
// ============================================================================
const ROLE_COPY: Record<Role, { singular: string; idHint: string }> = {
  participant: { singular: 'participant', idHint: 'auto: P-0001' },
  operator: { singular: 'room operator', idHint: 'auto: OP-001' },
  admin: { singular: 'core team member', idHint: 'auto: ADM-01' },
};

function AccountsTab({
  role,
  accounts,
  teams,
  rooms,
  roomLabel,
  teamById,
  currentAccountId,
  busy,
  onCreate,
  onUpdate,
  onDelete,
  onResetPin,
}: {
  role: Role;
  accounts: AccountSummary[];
  teams: ReturnType<typeof useTeams>['teams'];
  rooms: ReturnType<typeof useRooms>['rooms'];
  roomLabel: Record<string, string>;
  teamById: Record<string, ReturnType<typeof useTeams>['teams'][number]>;
  currentAccountId: string | null;
  busy: boolean;
  onCreate: (input: { role: Role; display_name: string; account_id?: string; team_id?: string; room_ids?: string[]; pin?: string }) => Promise<boolean>;
  onUpdate: (id: string, updates: { active?: boolean; team_id?: string; room_ids?: string[] }) => void;
  onDelete: (id: string) => void;
  onResetPin: (id: string) => void;
}) {
  const copy = ROLE_COPY[role];
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const dupTeamNames = useMemo(() => duplicateTeamNames(teams), [teams]);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [editingRooms, setEditingRooms] = useState<AccountSummary | null>(null);

  const filtered = accounts.filter((a) => {
    const q = search.trim().toLowerCase();
    if (q && !(a.account_id.toLowerCase().includes(q) || a.display_name.toLowerCase().includes(q))) return false;
    if (teamFilter && a.team_id !== teamFilter) return false;
    return true;
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await onCreate({
      role,
      display_name: name,
      account_id: accountId || undefined,
      team_id: role === 'participant' ? teamId : undefined,
      room_ids: role === 'operator' ? roomIds : undefined,
    });
    if (ok) {
      setName('');
      setAccountId('');
      setRoomIds([]);
    }
  };

  const canSubmit =
    name.trim() && (role !== 'participant' || teamId) && (role !== 'operator' || roomIds.length > 0) && !busy;

  return (
    <>
      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">NEW {copy.singular.toUpperCase()}</span>
            <h2>Add a {copy.singular}</h2>
          </div>
          <UserPlus size={20} />
        </div>
        <form className="inline-form" onSubmit={handleCreate}>
          <label className="field field-wide">
            <span>Full name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </label>
          {role === 'participant' && (
            <label className="field">
              <span>Team</span>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
                <option value="">Choose team…</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{teamLabel(t, dupTeamNames)}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>ID (optional)</span>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value.toUpperCase())} placeholder={copy.idHint} maxLength={40} />
          </label>
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            <Plus size={15} /> Create &amp; show PIN
          </button>
          {role === 'operator' && (
            <div className="room-chips" aria-label="Rooms">
              <span className="room-chips-label">Rooms</span>
              {rooms.length === 0 && <span className="panel-hint">Create rooms first.</span>}
              {rooms.map((r) => {
                const on = roomIds.indexOf(r.id) !== -1;
                return (
                  <button
                    type="button"
                    key={r.id}
                    className={on ? 'chip on' : 'chip'}
                    onClick={() => setRoomIds(on ? roomIds.filter((x) => x !== r.id) : roomIds.concat(r.id))}
                  >
                    {r.code}
                  </button>
                );
              })}
            </div>
          )}
        </form>
        {role === 'participant' && teams.length === 0 && <p className="panel-hint">Create a team first, or use Import CSV.</p>}
      </section>

      <section className="cyber-frame">
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by ID or name" />
          </label>
          {role === 'participant' && (
            <select className="inline-batch-select" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{teamLabel(t, dupTeamNames)}</option>
              ))}
            </select>
          )}
          <span className="panel-hint" style={{ margin: 0 }}>{filtered.length} shown</span>
        </div>
        <div className="cyber-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>NAME</th>
                {role === 'participant' && <th>TEAM</th>}
                {role === 'participant' && <th>ROOM</th>}
                {role === 'operator' && <th>ROOMS</th>}
                <th>LAST SIGN-IN</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const isSelf = a.account_id === currentAccountId;
                const team = a.team_id ? teamById[a.team_id] : null;
                return (
                  <tr key={a.id}>
                    <td><strong style={{ color: 'var(--white)' }}>{a.account_id}</strong>{isSelf && <span className="self-tag">YOU</span>}</td>
                    <td>{a.display_name}</td>
                    {role === 'participant' && (
                      <td>
                        <select className="inline-batch-select" value={a.team_id || ''} onChange={(e) => e.target.value && onUpdate(a.id, { team_id: e.target.value })}>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>{teamLabel(t, dupTeamNames)}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    {role === 'participant' && <td>{team && team.room_id ? roomLabel[team.room_id] || '—' : '—'}</td>}
                    {role === 'operator' && (
                      <td>
                        <button className="inline-dismiss" onClick={() => setEditingRooms({ ...a })} title="Change rooms">
                          {a.room_ids.map((id) => roomLabel[id]).filter(Boolean).join(', ') || 'none'}
                        </button>
                      </td>
                    )}
                    <td style={{ color: 'var(--muted)' }}>{timeAgo(a.last_login_at)}</td>
                    <td>
                      <button
                        className={a.active ? 'status-toggle on' : 'status-toggle'}
                        disabled={isSelf || busy}
                        onClick={() => {
                          if (a.active && !confirm('Deactivate ' + a.account_id + '? They are signed out immediately and cannot sign in.')) return;
                          onUpdate(a.id, { active: !a.active });
                        }}
                      >
                        {a.active ? 'ACTIVE' : 'DISABLED'}
                      </button>
                    </td>
                    <td>
                      <span className="row-actions">
                        <button
                          className="inline-dismiss"
                          disabled={isSelf || busy}
                          title={isSelf ? 'Change your own PIN in Settings' : 'Issue a new PIN'}
                          onClick={() => {
                            if (confirm('Reset the PIN for ' + a.account_id + '? Their old PIN stops working and they are signed out.')) onResetPin(a.id);
                          }}
                        >
                          <KeyRound size={12} /> Reset PIN
                        </button>
                        <button
                          className="icon-danger"
                          disabled={isSelf || busy}
                          onClick={() => {
                            if (confirm('Permanently delete ' + a.account_id + ' (' + a.display_name + ')?')) onDelete(a.id);
                          }}
                          title="Delete account"
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="empty-cell">No {copy.singular}s{search || teamFilter ? ' match' : ' yet'}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editingRooms && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setEditingRooms(null)}><X size={18} /></button>
            <span className="eyebrow">ROOM ACCESS</span>
            <h2>{editingRooms.display_name}</h2>
            <p>This operator can only see issues and send alerts for the rooms selected here.</p>
            <div className="room-chips">
              {rooms.map((r) => {
                const on = editingRooms.room_ids.indexOf(r.id) !== -1;
                return (
                  <button
                    type="button"
                    key={r.id}
                    className={on ? 'chip on' : 'chip'}
                    onClick={() =>
                      setEditingRooms({
                        ...editingRooms,
                        room_ids: on ? editingRooms.room_ids.filter((x) => x !== r.id) : editingRooms.room_ids.concat(r.id),
                      })
                    }
                  >
                    {r.code}
                  </button>
                );
              })}
            </div>
            <button
              className="primary-action modal-send"
              style={{ marginTop: 18 }}
              disabled={editingRooms.room_ids.length === 0}
              onClick={() => {
                onUpdate(editingRooms.id, { room_ids: editingRooms.room_ids });
                setEditingRooms(null);
              }}
            >
              Save rooms
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================================
// CSV import
// ============================================================================
function ImportTab({ onImported }: { onImported: (credentials: IssuedCredential[], kind: string) => void }) {
  const [kind, setKind] = useState<'participants' | 'operators'>('participants');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<'preview' | 'import' | null>(null);

  const reset = (nextCsv: string) => {
    setCsv(nextCsv);
    setResult(null);
    setError('');
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => reset(String(reader.result || ''));
    reader.readAsText(file);
  };

  const run = async (commit: boolean) => {
    setWorking(commit ? 'import' : 'preview');
    setError('');
    const { data, error: apiError } = await importAccounts(kind, csv, commit);
    setWorking(null);
    if (apiError) {
      setError(apiError.message);
      return;
    }
    setResult(data);
    if (data && data.committed && data.credentials) {
      onImported(data.credentials, kind);
      setCsv('');
      setResult(null);
    }
  };

  const template = kind === 'participants' ? PARTICIPANT_TEMPLATE : OPERATOR_TEMPLATE;
  const clean = result && !result.committed && result.summary.errors === 0;

  return (
    <section className="cyber-frame">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">BULK IMPORT</span>
          <h2>Import from CSV</h2>
        </div>
        <FileUp size={20} />
      </div>

      <div className="segmented segmented-small">
        <button className={kind === 'participants' ? 'active' : ''} onClick={() => { setKind('participants'); reset(''); }}>Participants</button>
        <button className={kind === 'operators' ? 'active' : ''} onClick={() => { setKind('operators'); reset(''); }}>Room operators</button>
      </div>

      <div className="import-help">
        {kind === 'participants' ? (
          <>
            <p>
              Columns: <code>name</code>, <code>team</code>, <code>team_id</code> (optional), <code>room</code> (room code),{' '}
              <code>id</code> (optional). New team names are created automatically in the given room. Blank IDs are
              generated. <b>PINs are always generated.</b>
            </p>
            <p>
              Team names may repeat, and a name is matched <b>within the room the row names</b> — a &quot;Hack Horizon&quot; in
              F201 is a new team, not the one already sitting in F101. To add people to an existing team, give its{' '}
              <code>team_id</code> — the code shown in the Teams tab, like <code>T-004</code>. That pins the row to one exact
              team; if a <code>team</code> name beside it disagrees, the row is flagged. <b>Export teams</b> gives you a sheet
              with the codes already in it.
            </p>
          </>
        ) : (
          <p>
            Columns: <code>name</code>, <code>rooms</code> (codes separated by <code>|</code>), <code>id</code> (optional). Rooms must
            already exist. <b>PINs are always generated.</b>
          </p>
        )}
        <pre className="import-template">{template}</pre>
      </div>

      <div className="import-inputs">
        <label className="outline-action file-picker">
          <Upload size={15} /> Choose .csv file
          <input type="file" accept=".csv,text/csv" onChange={(e) => handleFile(e.target.files?.[0])} />
        </label>
        <span className="panel-hint" style={{ margin: 0 }}>or paste below</span>
      </div>
      <textarea className="import-textarea" value={csv} onChange={(e) => reset(e.target.value)} rows={8} placeholder={template} spellCheck={false} />

      {error && <div className="action-error"><span>{error}</span></div>}

      <div className="import-actions">
        <button className="outline-action" disabled={!csv.trim() || working !== null} onClick={() => run(false)}>
          {working === 'preview' ? 'Checking…' : 'Preview'}
        </button>
        <button className="primary-action" disabled={!clean || working !== null} onClick={() => run(true)}>
          {working === 'import' ? 'Creating accounts…' : 'Import ' + (result ? result.summary.rows : '') + ' ' + kind}
        </button>
      </div>

      {result && (
        <>
          <div className={result.summary.errors ? 'import-summary bad' : 'import-summary good'}>
            {result.summary.errors
              ? result.summary.errors + ' row(s) need fixing. Nothing will be created until every row is valid.'
              : result.summary.rows + ' rows ready' +
                (result.summary.generated_ids ? ' · ' + result.summary.generated_ids + ' IDs will be generated' : '') +
                (result.summary.new_teams && result.summary.new_teams.length ? ' · new teams: ' + result.summary.new_teams.join(', ') : '')}
          </div>
          <div className="cyber-table-wrap">
            <table className="cyber-table">
              <thead>
                <tr>
                  <th>LINE</th>
                  <th>ID</th>
                  <th>NAME</th>
                  <th>{kind === 'participants' ? 'TEAM / ROOM' : 'ROOMS'}</th>
                  <th>CHECK</th>
                </tr>
              </thead>
              <tbody>
                {result.preview.map((row) => (
                  <tr key={row.line} className={row.error ? 'row-error' : ''}>
                    <td>{row.line}</td>
                    <td>{row.account_id || <span style={{ color: 'var(--muted)' }}>auto</span>}</td>
                    <td>{row.name}</td>
                    <td>
                      {kind === 'participants'
                        ? (row.team || '') +
                          (row.team_id ? ' [' + row.team_id + ']' : '') +
                          (row.room ? ' · ' + row.room : '') +
                          (row.new_team ? ' (new)' : '')
                        : (row.rooms || []).join(', ')}
                    </td>
                    <td>{row.error ? <span style={{ color: 'var(--red-bright)' }}>{row.error}</span> : <span style={{ color: 'var(--green)' }}>OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
