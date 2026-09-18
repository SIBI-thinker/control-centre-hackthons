import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { findDuplicateUsernames, parseLogins, type ParsedLogin } from '@/lib/wifi-parse';
import { ambiguousTeamMessage, buildTeamIndex, type TeamRef } from '@/lib/server/teams';

export const dynamic = 'force-dynamic';

const MAX_LOGINS = 1000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** Pulls the text out of a PDF so the usual parser can read it. */
async function pdfToText(bytes: Buffer): Promise<string> {
  // The package's index.js runs a demo read at import time; the lib entry
  // point is the parser on its own.
  const parse = (await import('pdf-parse/lib/pdf-parse.js')).default as (data: Buffer) => Promise<{ text: string }>;
  try {
    const result = await parse(bytes);
    return result.text || '';
  } catch {
    throw new HttpError(400, 'That PDF could not be read. It may be scanned images rather than text — paste the logins instead.');
  }
}

/**
 * Imports Wi-Fi logins from pasted text, a CSV, or a PDF.
 *
 *   commit: false → parse and report what was found; saves nothing
 *   commit: true  → save, but only if every row is usable
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const db = getServiceClient();

  let text = '';
  let commit = false;
  let sourceName = 'pasted text';

  const contentType = req.headers.get('content-type') || '';
  if (contentType.indexOf('multipart/form-data') !== -1) {
    const form = await req.formData();
    commit = String(form.get('commit')) === 'true';
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'No file received.');
    if (file.size > MAX_PDF_BYTES) throw new HttpError(400, 'That file is too large (max 8 MB).');
    sourceName = (file as File).name || 'file';
    const buffer = Buffer.from(await file.arrayBuffer());
    const isPdf = buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF';
    text = isPdf ? await pdfToText(buffer) : buffer.toString('utf8');
  } else {
    const body = (await req.json().catch(() => ({}))) as { text?: string; commit?: boolean };
    text = typeof body.text === 'string' ? body.text : '';
    commit = body.commit === true;
  }

  if (!text.trim()) throw new HttpError(400, 'No text found to read. If the PDF is a scan, paste the logins instead.');

  const { logins, skipped } = parseLogins(text);
  if (logins.length === 0) {
    return json({ logins: [], skipped, duplicates: [], conflicts: [], unknown: [], ambiguous: [], committed: false, source: sourceName, extracted_text: text.slice(0, 4000) });
  }
  if (logins.length > MAX_LOGINS) throw new HttpError(400, 'At most ' + MAX_LOGINS + ' logins per import.');

  const duplicates = findDuplicateUsernames(logins);

  // Usernames already in the pool.
  const { data: existing, error } = await db.from('wifi_credentials').select('username');
  if (error) throw error;
  const taken = new Set((existing ?? []).map((c) => c.username.toLowerCase()));
  const conflicts = logins.filter((l) => taken.has(l.username.toLowerCase())).map((l) => l.username);

  // Resolve any team / participant named in the file.
  const teamNames = Array.from(new Set(logins.map((l) => l.team).filter(Boolean) as string[]));
  const accountIds = Array.from(new Set(logins.map((l) => l.account_id).filter(Boolean) as string[]));
  const unknown: string[] = [];
  // Names that match more than one team: the file has to say which, by code.
  const ambiguous: string[] = [];
  const teamIdByValue = new Map<string, string>();
  const accountById = new Map<string, string>();

  if (teamNames.length > 0) {
    const { data: teams, error: teamsError } = await db.from('teams').select('id, code, name');
    if (teamsError) throw teamsError;
    const teamIndex = buildTeamIndex((teams ?? []) as TeamRef[]);
    teamNames.forEach((value) => {
      const found = teamIndex.match(value);
      if (found.kind === 'team') teamIdByValue.set(value, found.team.id);
      else if (found.kind === 'ambiguous') ambiguous.push(ambiguousTeamMessage(value, found.matches));
    });
  }
  if (accountIds.length > 0) {
    const { data: accounts, error: accountsError } = await db.from('accounts').select('id, account_id').eq('role', 'participant').in('account_id', accountIds);
    if (accountsError) throw accountsError;
    (accounts ?? []).forEach((a) => accountById.set(a.account_id, a.id));
  }

  teamNames.forEach((name) => {
    if (!teamIdByValue.has(name) && !ambiguous.some((m) => m.includes('"' + name.trim() + '"'))) unknown.push('team "' + name + '"');
  });
  accountIds.forEach((id) => {
    if (!accountById.has(id)) unknown.push('participant ' + id);
  });

  const blocked = duplicates.length > 0 || conflicts.length > 0 || unknown.length > 0 || ambiguous.length > 0;

  if (!commit || blocked) {
    return json({
      logins: logins.map((l) => ({ ...l, conflict: taken.has(l.username.toLowerCase()) })),
      skipped,
      duplicates,
      conflicts,
      unknown,
      ambiguous,
      committed: false,
      source: sourceName,
      extracted_text: text.slice(0, 4000),
    });
  }

  const rows = logins.map((l: ParsedLogin) => ({
    username: l.username,
    password: l.password,
    label: l.label ?? null,
    assigned_team_id: l.team ? teamIdByValue.get(l.team) ?? null : null,
    assigned_account_id: l.account_id ? accountById.get(l.account_id) ?? null : null,
  }));

  const { error: insertError } = await db.from('wifi_credentials').insert(rows);
  if (insertError) {
    if (insertError.code === '23505') throw new HttpError(409, 'One of these logins was added by someone else meanwhile. Preview again.');
    throw insertError;
  }

  await audit(account.account_id, 'WIFI_LOGINS_IMPORTED', rows.length + ' logins', 'from ' + sourceName);
  return json({ logins, skipped, duplicates: [], conflicts: [], unknown: [], ambiguous: [], committed: true, imported: rows.length, source: sourceName });
});
