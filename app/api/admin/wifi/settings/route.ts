import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { optionalText } from '@/lib/server/validate';
import { invalidateWifiSettings } from '@/lib/server/wifi';

export const dynamic = 'force-dynamic';

/** The venue-wide SSID, joining instructions, and optional fallback login. */
export const PATCH = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const updates: Record<string, string | null> = {};
  if (body.ssid !== undefined) updates.ssid = optionalText(body.ssid, 64);
  // The passphrase for joining the network itself — not a per-team login.
  if (body.ssid_password !== undefined) updates.ssid_password = optionalText(body.ssid_password, 120);
  if (body.instructions !== undefined) updates.instructions = optionalText(body.instructions, 1000);
  if (body.default_username !== undefined) updates.default_username = optionalText(body.default_username, 120);
  if (body.default_password !== undefined) updates.default_password = optionalText(body.default_password, 120);
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const { error } = await getServiceClient()
    .from('wifi_settings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) throw error;

  invalidateWifiSettings();
  await audit(account.account_id, 'WIFI_SETTINGS_UPDATED', updates.ssid ?? null, Object.keys(updates).join(', '));
  return json({ ok: true });
});
