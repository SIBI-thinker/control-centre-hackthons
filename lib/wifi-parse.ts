import { csvToRecords, parseCsv } from '@/lib/csv';

/**
 * Reads a list of Wi-Fi logins out of pasted text, a CSV, or the text pulled
 * from a PDF.
 *
 * Colleges hand these over in every imaginable shape, so this is deliberately
 * tolerant — and every result is shown for confirmation before anything is
 * saved, because a mis-read here would hand teams the wrong logins.
 *
 * Understood forms:
 *   a CSV with username/password columns (plus optional team, id, label)
 *   user1,pass1
 *   user1    pass1          (two or more spaces, or a tab)
 *   user1 | pass1   /   user1 - pass1   /   user1 : pass1
 *   Username: user1  Password: pass1    (one line or two)
 */

export type ParsedLogin = {
  username: string;
  password: string;
  label?: string;
  team?: string;
  account_id?: string;
  line: number;
};

export type ParseResult = { logins: ParsedLogin[]; skipped: { line: number; text: string }[] };

const LABELLED = /^\s*(?:user(?:\s*name|\s*id)?|login|id)\s*[:\-=]\s*(\S+)(?:\s+(?:pass(?:word)?|pwd|key)\s*[:\-=]?\s*(\S+))?\s*$/i;
const PASSWORD_ONLY = /^\s*(?:pass(?:word)?|pwd|key)\s*[:\-=]\s*(\S+)\s*$/i;
const PAIR_SEPARATOR = /^(\S+)\s*(?:,|\||\t|\s{2,}|\s+[-–—:]\s+)\s*(\S.*?)\s*$/;

const USERNAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._@-]{1,63}$/;
const PASSWORD_SHAPE = /^[\x21-\x7E]{2,64}$/;

/**
 * Does a candidate pair actually look like credentials?
 *
 * Without this, any two words on a line become a login: fed a document that
 * happens to contain prose, the parser cheerfully reads "Andreas Gal" and
 * "Mozilla Corporation" as usernames and passwords. Guessing is only allowed
 * where the format states what the values are (CSV columns, or "Username:"
 * labels); everywhere else the pair has to look the part.
 */
function plausiblePair(username: string, password: string, guessing: boolean): boolean {
  if (!USERNAME_SHAPE.test(username) || !PASSWORD_SHAPE.test(password)) return false;
  // Sentence tails give prose away.
  if (/[.,;:!?]$/.test(password)) return false;
  if (!guessing) return true;

  // Two plain English-looking words are almost always prose, never a login.
  if (/^[A-Za-z]+$/.test(username) && /^[A-Za-z]+$/.test(password)) return false;
  // A numbered heading followed by a word: "3.1 Traces", "6.4 Preemption".
  if (!/[A-Za-z]/.test(username) && /^[A-Za-z]+$/.test(password)) return false;
  // Brackets belong to code and citations, not to passwords people type in.
  if (/[()\[\]{}<>]/.test(password)) return false;
  return true;
}

/**
 * Strips list bullets ("1.", "1)", "-", "•") and the bare serial-number column
 * PDF tables start with — but only when enough of the line survives to still
 * hold a username and a password, so "guest01 Pass@123" is never damaged.
 */
function stripBullet(line: string): string {
  const withoutBullet = line.replace(/^\s*(?:\d+\s*[.)\]]|[-–—•*])\s+/, '').trim();
  if (withoutBullet !== line.trim()) return withoutBullet;

  const serial = /^\s*\d{1,4}\s+(\S.*)$/.exec(line);
  if (serial && serial[1].trim().split(/\s+/).length >= 2) return serial[1].trim();
  return line.trim();
}

function looksLikeHeading(line: string): boolean {
  const l = line.toLowerCase();
  if (/^(s\.?\s*no|sl\.?\s*no|serial|sr\.?\s*no)\b/.test(l)) return true;
  if (/^(wi[\s-]?fi|internet|network|ssid|credential|login)s?\b.*(detail|credential|list|access)?/.test(l) && !/[:=]\s*\S/.test(l)) return true;
  // A row that is only the two column names.
  return /^\s*user\s*(name|id)?\s*[,|\t ]+pass(word)?\s*$/i.test(line);
}

export function parseLogins(text: string): ParseResult {
  const logins: ParsedLogin[] = [];
  const skipped: { line: number; text: string }[] = [];

  // --- CSV with a header row -------------------------------------------------
  const firstRow = parseCsv(text)[0];
  const headers = (firstRow || []).map((h) => h.trim().toLowerCase());
  const hasUser = headers.some((h) => h === 'username' || h === 'user' || h === 'userid' || h === 'user id' || h === 'login');
  const hasPass = headers.some((h) => h === 'password' || h === 'pass' || h === 'pwd');

  if (hasUser && hasPass) {
    const { records } = csvToRecords(text, []);
    records.forEach((record, index) => {
      const username = (record.username || record.user || record.userid || record['user id'] || record.login || '').trim();
      const password = (record.password || record.pass || record.pwd || '').trim();
      const line = index + 2;
      if (!username || !password) {
        skipped.push({ line, text: [username, password].filter(Boolean).join(' ') || '(empty row)' });
        return;
      }
      logins.push({
        username,
        password,
        label: (record.label || record.note || '').trim() || undefined,
        team: (record.team || '').trim() || undefined,
        account_id: (record.id || record.participant || '').trim().toUpperCase() || undefined,
        line,
      });
    });
    return { logins, skipped };
  }

  // --- Loose lines -----------------------------------------------------------
  const lines = text.split(/\r?\n/);
  // A plain loop rather than forEach: `pendingUser` is read after the loop, and
  // assignments inside a callback are invisible to the type checker.
  let pendingUser: { username: string; line: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const cleaned = stripBullet(lines[index]);
    if (!cleaned) continue;
    if (looksLikeHeading(cleaned)) continue;

    // "Password: xyz" completing a "Username: abc" from a previous line.
    const passwordOnly = PASSWORD_ONLY.exec(cleaned);
    if (passwordOnly && pendingUser) {
      logins.push({ username: pendingUser.username, password: passwordOnly[1], line: pendingUser.line });
      pendingUser = null;
      continue;
    }

    const labelled = LABELLED.exec(cleaned);
    if (labelled) {
      if (labelled[2]) logins.push({ username: labelled[1], password: labelled[2], line });
      else pendingUser = { username: labelled[1], line };
      continue;
    }

    const pair = PAIR_SEPARATOR.exec(cleaned);
    if (pair) {
      // A trailing label after a second separator, e.g. "user pass Team A".
      const rest = pair[2].split(/\s{2,}|\t|\s+[-–—|]\s+/);
      const password = rest[0].trim();
      const label = rest.slice(1).join(' ').trim();
      if (password && plausiblePair(pair[1], password, true)) {
        logins.push({ username: pair[1], password, label: label || undefined, line });
        continue;
      }
    }

    // Last resort: exactly two words, one space — "guest01 Pass@123".
    // Only two, so a sentence is never mistaken for a login.
    const words = cleaned.split(/\s+/);
    if (words.length === 2 && plausiblePair(words[0], words[1], true)) {
      logins.push({ username: words[0], password: words[1], line });
      continue;
    }

    skipped.push({ line, text: cleaned.slice(0, 120) });
  }

  if (pendingUser) skipped.push({ line: pendingUser.line, text: pendingUser.username + ' (no password found)' });

  return { logins, skipped };
}

/** Flags duplicate usernames inside one import. */
export function findDuplicateUsernames(logins: ParsedLogin[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  logins.forEach((l) => {
    const key = l.username.toLowerCase();
    if (seen.has(key)) duplicates.add(l.username);
    seen.add(key);
  });
  return Array.from(duplicates);
}
