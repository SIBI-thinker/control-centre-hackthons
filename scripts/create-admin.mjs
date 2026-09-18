#!/usr/bin/env node
/**
 * Creates an admin account, or resets an existing account's PIN.
 *
 *   npm run create-admin
 *
 * Runs on your machine with the service-role key, so no setup page is ever
 * exposed on the website. Use it for the first admin, and to recover if every
 * admin is locked out.
 *
 * The PIN hash format below MUST match lib/server/pin.ts.
 */

import { pbkdf2, randomBytes, randomInt } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { promisify } from 'util';
import readline from 'readline';
import { createClient } from '@supabase/supabase-js';

const pbkdf2Async = promisify(pbkdf2);
const ITERATIONS = 600000;

async function hashPin(pin) {
  const salt = randomBytes(16);
  const derived = await pbkdf2Async(pin, salt, ITERATIONS, 32, 'sha256');
  return ['pbkdf2_sha256', ITERATIONS, salt.toString('base64'), derived.toString('base64')].join('$');
}

function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing while the PIN is typed.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
      };
    }
    rl.question(question, (answer) => {
      if (hidden) rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

function fail(message) {
  console.error('\n  ✗ ' + message + '\n');
  process.exit(1);
}

async function main() {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) fail('NEXT_PUBLIC_SUPABASE_URL is not set in .env');
  if (!serviceKey) fail('SUPABASE_SERVICE_ROLE_KEY is not set in .env (Supabase dashboard → Project Settings → API).');

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  console.log('\n  YHACK\'26 — create or reset an admin account\n');

  const accountId = (await prompt('  Admin ID (e.g. ADM-SIBI): ')).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(accountId)) {
    fail('ID must be 2–40 characters: letters, numbers, dot, dash, underscore.');
  }

  const { data: existing, error: lookupError } = await db
    .from('accounts')
    .select('id, role, display_name')
    .eq('account_id', accountId)
    .maybeSingle();
  if (lookupError) {
    if (/relation .* does not exist|Could not find the table/i.test(lookupError.message)) {
      fail('The accounts table does not exist yet. Run the Stage 1 migration first.');
    }
    fail(lookupError.message);
  }

  let displayName = existing?.display_name;
  if (existing) {
    if (existing.role !== 'admin') fail(accountId + ' exists but is a ' + existing.role + ' account, not an admin.');
    const answer = await prompt('  ' + accountId + ' already exists. Reset its PIN? (y/N): ');
    if (answer.toLowerCase() !== 'y') fail('Cancelled.');
  } else {
    displayName = await prompt('  Full name: ');
    if (!displayName) fail('Name is required.');
  }

  const mode = await prompt('  Type a PIN, or press Enter to generate one: ', { hidden: true });
  let pin = mode;
  let generated = false;

  if (!pin) {
    pin = Array.from({ length: 6 }, () => String(randomInt(0, 10))).join('');
    generated = true;
  } else {
    if (!/^\d{6,12}$/.test(pin)) fail('PIN must be 6–12 digits.');
    const confirm = await prompt('  Confirm PIN: ', { hidden: true });
    if (confirm !== pin) fail('PINs do not match.');
  }

  process.stdout.write('  Hashing PIN…');
  const pinHash = await hashPin(pin);
  process.stdout.write(' done\n');

  if (existing) {
    // Bumping session_version signs this admin out everywhere.
    const { data: current } = await db.from('accounts').select('session_version').eq('id', existing.id).maybeSingle();
    const { error } = await db
      .from('accounts')
      .update({ pin_hash: pinHash, active: true, session_version: (current?.session_version ?? 1) + 1, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) fail(error.message);
  } else {
    const { error } = await db.from('accounts').insert({
      account_id: accountId,
      role: 'admin',
      display_name: displayName,
      pin_hash: pinHash,
    });
    if (error) fail(error.message);
  }

  await db.from('event_audit_logs').insert({
    action: existing ? 'ADMIN_PIN_RESET' : 'ADMIN_CREATED',
    actor: 'SETUP_SCRIPT',
    target: accountId,
    details: existing ? 'PIN reset from local setup script; other sessions ended' : 'Created from local setup script',
  });

  console.log('\n  ✓ ' + (existing ? 'PIN reset for ' : 'Admin created: ') + accountId);
  if (generated) {
    console.log('\n    PIN: ' + pin);
    console.log('    This is shown once and is not stored anywhere readable. Write it down now.');
  }
  console.log('');
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
