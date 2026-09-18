import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { resilientFetch } from '@/lib/server/resilient-fetch';

/**
 * Service-role Supabase client. Bypasses row-level security, so it must only
 * ever run on the server — `server-only` fails the build if a client component
 * imports this file.
 */

let client: SupabaseClient | null = null;

export class ServerConfigError extends Error {}

export function getServiceClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new ServerConfigError(
      'Server is not configured: SUPABASE_SERVICE_ROLE_KEY is missing. Add it to the environment and restart.'
    );
  }

  client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Retries reads through a Wi-Fi blip and names the cause when it can't.
    global: { fetch: resilientFetch },
  });
  return client;
}
