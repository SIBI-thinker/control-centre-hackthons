/**
 * Event branding.
 *
 * The event name and host organisation are editable in System Settings, so
 * nothing in the UI may hard-code "YHACK'26" — a renamed event has to show its
 * new name on every screen: displays, sign-in, the console and the portals.
 */

export const FALLBACK_EVENT_NAME = "YHACK'26";
export const FALLBACK_ORGANIZATION = 'IEEE Robotics and Automation Society';

export type Brand = {
  /** Full name, e.g. "YHACK'26". */
  name: string;
  /** The part rendered in the primary colour, e.g. "YHACK". */
  main: string;
  /** A trailing year, e.g. "'26" — rendered in the accent colour. May be empty. */
  accent: string;
  /** Single letter for the square logo tile. */
  mark: string;
  organization: string;
};

/**
 * Splits a trailing year off the name so the existing two-tone lockup still
 * works: "YHACK'26" → YHACK + '26, "Jarvis" → Jarvis + nothing.
 */
export function splitBrandName(name: string): { main: string; accent: string } {
  const trimmed = (name || '').trim();
  const match = /^(.+?)\s*(['’‘]\s*\d{2,4}|\s\d{4})$/.exec(trimmed);
  if (match && match[1].trim()) return { main: match[1].trim(), accent: match[2].replace(/\s+/g, '') };
  return { main: trimmed, accent: '' };
}

export function brandMark(name: string): string {
  const letter = (name || '').replace(/[^A-Za-z0-9]/g, '').charAt(0);
  return (letter || 'Y').toUpperCase();
}

export function makeBrand(name?: string | null, organization?: string | null): Brand {
  const full = (name || '').trim() || FALLBACK_EVENT_NAME;
  const { main, accent } = splitBrandName(full);
  return {
    name: full,
    main,
    accent,
    mark: brandMark(full),
    organization: (organization || '').trim() || FALLBACK_ORGANIZATION,
  };
}

/** Lower-case, hyphenated form of the event name, for download filenames. */
export function brandSlug(name?: string | null): string {
  const slug = (name || '')
    .toLowerCase()
    .replace(/['’‘]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'event';
}
