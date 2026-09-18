import 'server-only';
import webpush from 'web-push';
import { getServiceClient } from '@/lib/server/db';

/**
 * Browser push to staff devices. Signs with our own VAPID keys, so no
 * third-party push account is involved — the browser vendor's push service
 * just relays the encrypted message.
 */

let configured: boolean | null = null;

export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  /** Page to open when the notification is clicked. */
  url: string;
  /** Same tag replaces an older notification instead of stacking. */
  tag?: string;
  urgent?: boolean;
};

/**
 * Sends to every subscribed device of the given accounts. Never throws:
 * a push failure must not fail the action (e.g. raising an issue) that
 * triggered it. Dead subscriptions are removed.
 */
export async function pushToAccounts(accounts: { id: string; role: string }[], build: (role: string) => PushPayload) {
  if (!pushConfigured() || accounts.length === 0) return;

  try {
    const db = getServiceClient();
    const roleById = new Map(accounts.map((a) => [a.id, a.role]));
    const { data: subs, error } = await db
      .from('push_subscriptions')
      .select('id, account_id, endpoint, p256dh, auth')
      .in('account_id', Array.from(roleById.keys()));
    if (error || !subs || subs.length === 0) return;

    const dead: string[] = [];
    const delivered: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub) => {
        const payload = build(roleById.get(sub.account_id) || 'admin');
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 30, urgency: payload.urgent ? 'high' : 'normal', timeout: 8000 }
          );
          delivered.push(sub.id);
        } catch (err: any) {
          // 404/410: the browser dropped this subscription for good.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(sub.id);
          else console.error('[push]', err && err.statusCode, err && err.body);
        }
      })
    );

    if (dead.length > 0) await db.from('push_subscriptions').delete().in('id', dead);
    if (delivered.length > 0) {
      await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString() }).in('id', delivered);
    }
  } catch (err) {
    console.error('[push] unexpected', err);
  }
}
