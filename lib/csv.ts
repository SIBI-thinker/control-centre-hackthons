/**
 * Small RFC 4180 CSV parser/writer. Handles quoted fields containing commas,
 * quotes ("" escapes) and line breaks — team names like "Byte, Me" are exactly
 * what a naive split(',') gets wrong.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Strip a UTF-8 BOM that Excel adds.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully blank lines.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function escapeCell(value: string): string {
  // Also neutralise spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((cell) => escapeCell(cell ?? '')).join(',')).join('\r\n') + '\r\n';
}

/**
 * Maps rows to objects keyed by lower-cased header, and reports which of the
 * required columns are missing.
 */
export function csvToRecords(
  text: string,
  required: string[]
): { records: Record<string, string>[]; missing: string[]; headers: string[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { records: [], missing: required, headers: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const missing = required.filter((col) => headers.indexOf(col) === -1);

  const records = rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim();
    });
    return record;
  });

  return { records, missing, headers };
}
