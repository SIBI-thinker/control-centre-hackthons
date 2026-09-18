import { toCsv } from '@/lib/csv';

/** Saves rows as a CSV file from the browser. Excel-safe via toCsv's escaping. */
export function downloadCsv(filename: string, rows: string[][]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 2026-09-18-1432 — sortable, and safe in a filename on every OS. */
export function fileStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes())
  );
}

/**
 * Downloads a file the server generated, surfacing a JSON error instead of
 * dumping it into a new tab. Returns an error message, or null on success.
 */
export async function downloadFromApi(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin' });
  } catch {
    return 'Network error — check the connection and try again.';
  }

  const type = response.headers.get('Content-Type') || '';
  if (!response.ok || type.indexOf('application/json') !== -1) {
    const body = await response.json().catch(() => ({}));
    return body.error || 'That export failed (' + response.status + ').';
  }

  const blob = await response.blob();
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name ? name[1] : 'export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  return null;
}
