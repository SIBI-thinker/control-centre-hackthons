'use client';

import { useState } from 'react';
import { DoorOpen, Pencil, Plus, Trash2, X } from 'lucide-react';
import { createRooms, deleteRoom, updateRoom, useRooms, type RoomWithCounts } from '@/lib/admin-api';

/**
 * Parses pasted lines of "CODE, Name, Location". Name defaults to the code so
 * a plain list of room numbers ("F101", "F102") is enough.
 */
function parseRoomLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code, name, ...rest] = line.split(',').map((p) => p.trim());
      return { code, name: name || code, location: rest.join(', ') || undefined };
    });
}

export function RoomsPanel({ onChanged }: { onChanged?: () => void }) {
  const { rooms, loading, error, refetch } = useRooms();
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [editing, setEditing] = useState<RoomWithCounts | null>(null);

  const done = async (result: { error: { message: string } | null }) => {
    setActionError(result.error ? result.error.message : '');
    if (!result.error) {
      await refetch();
      onChanged?.();
    }
    return !result.error;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await done(await createRooms([{ code, name: name || code, location: location || undefined }]));
    setBusy(false);
    if (ok) {
      setCode('');
      setName('');
      setLocation('');
    }
  };

  const bulkRooms = parseRoomLines(bulkText);

  const handleBulk = async () => {
    if (bulkRooms.length === 0) return;
    setBusy(true);
    const ok = await done(await createRooms(bulkRooms));
    setBusy(false);
    if (ok) {
      setBulkText('');
      setBulkOpen(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const ok = await done(await updateRoom(editing.id, { code: editing.code, name: editing.name, location: editing.location || null }));
    if (ok) setEditing(null);
  };

  const handleDelete = async (room: RoomWithCounts) => {
    const impact = [
      room.display_count && room.display_count + ' display(s)',
      room.team_count && room.team_count + ' team(s)',
      room.operator_count && room.operator_count + ' operator assignment(s)',
    ].filter(Boolean);
    const message =
      'Delete room ' + room.code + '?' + (impact.length ? '\n\n' + impact.join(', ') + ' will be unassigned. Phases lose this room.' : '');
    if (!confirm(message)) return;
    await done(await deleteRoom(room.id));
  };

  return (
    <div className="view-container">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">VENUE ROOMS</span>
          <p>Rooms group displays, teams and operators. Phases and room alerts are aimed at rooms.</p>
        </div>
        <button className="outline-action" onClick={() => setBulkOpen(true)}>
          <Plus size={16} /> Add many rooms
        </button>
      </div>

      {(actionError || error) && <div className="action-error"><span>{actionError || error}</span></div>}

      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">NEW ROOM</span>
            <h2>Add a room</h2>
          </div>
          <DoorOpen size={20} />
        </div>
        <form className="inline-form" onSubmit={handleCreate}>
          <label className="field">
            <span>Code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="F101" maxLength={40} required />
          </label>
          <label className="field field-wide">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="CSE Lab 1 (defaults to code)" maxLength={80} />
          </label>
          <label className="field field-wide">
            <span>Location</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="1st floor, F block" maxLength={120} />
          </label>
          <button type="submit" className="primary-action" disabled={busy || !code.trim()}>
            <Plus size={15} /> Add
          </button>
        </form>
      </section>

      <section className="cyber-frame">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{rooms.length} ROOMS</span>
            <h2>Room directory</h2>
          </div>
        </div>
        <div className="cyber-table-wrap">
          <table className="cyber-table">
            <thead>
              <tr>
                <th>CODE</th>
                <th>NAME</th>
                <th>LOCATION</th>
                <th>DISPLAYS</th>
                <th>TEAMS</th>
                <th>OPERATORS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.id}>
                  <td><strong style={{ color: 'var(--white)' }}>{room.code}</strong></td>
                  <td>{room.name}</td>
                  <td style={{ color: 'var(--muted)' }}>{room.location || '—'}</td>
                  <td>{room.display_count}</td>
                  <td>{room.team_count}</td>
                  <td>{room.operator_count}</td>
                  <td>
                    <span className="row-actions">
                      <button className="inline-dismiss" onClick={() => setEditing({ ...room })} title="Edit room">
                        <Pencil size={12} />
                      </button>
                      <button className="icon-danger" onClick={() => handleDelete(room)} title="Delete room">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && rooms.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    No rooms yet. Add them above, or paste a list with “Add many rooms”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="panel-hint">Assign each display to its room from the Displays tab.</p>
      </section>

      {bulkOpen && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setBulkOpen(false)}><X size={18} /></button>
            <span className="eyebrow">BULK ADD</span>
            <h2>Add many rooms</h2>
            <p>One room per line: <code>CODE, Name, Location</code>. Only the code is required.</p>
            <label>
              Rooms
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={10}
                placeholder={'F101, CSE Lab 1, F block\nF102\nAIML-A, AIML Lab A'}
              />
            </label>
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>
              {bulkRooms.length} room{bulkRooms.length === 1 ? '' : 's'} ready. Codes must be unique; nothing is added if any
              line is invalid.
            </p>
            <button className="primary-action modal-send" onClick={handleBulk} disabled={busy || bulkRooms.length === 0}>
              <Plus size={15} /> Add {bulkRooms.length} room{bulkRooms.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop">
          <div className="alert-modal">
            <button className="modal-close" onClick={() => setEditing(null)}><X size={18} /></button>
            <span className="eyebrow">EDIT ROOM</span>
            <h2>{editing.code}</h2>
            <form onSubmit={handleSaveEdit}>
              <label>
                Code
                <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} maxLength={40} required />
              </label>
              <label>
                Name
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={80} required />
              </label>
              <label>
                Location
                <input value={editing.location || ''} onChange={(e) => setEditing({ ...editing, location: e.target.value })} maxLength={120} />
              </label>
              <button type="submit" className="primary-action modal-send" style={{ marginTop: 16 }}>
                Save room
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
