'use strict';
// ─── Persistent brute-force tracking ─────────────────────────────────────────
// Uses Supabase table `login_attempts` as source of truth.
// Falls back to in-memory Map if table doesn't exist yet (migration not applied).

const supabase = require('./supabase');

const LOGIN_LOCK_MAX_ATTEMPTS = Number(process.env.LOGIN_LOCK_MAX_ATTEMPTS) || 5;
const LOGIN_LOCK_DURATION_MS  = Number(process.env.LOGIN_LOCK_DURATION_MS)  || 15 * 60 * 1000;
const LOGIN_LOCK_WINDOW_MS    = Number(process.env.LOGIN_LOCK_WINDOW_MS)    || 60 * 60 * 1000;

// ─── In-memory fallback (used if DB table not available) ─────────────────────
const _mem = new Map();

function normalizeKey(email) {
  return (email || '').toLowerCase().trim();
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function dbGet(emailKey) {
  try {
    const { data, error } = await supabase
      .from('login_attempts')
      .select('attempts, lock_until')
      .eq('email_key', emailKey)
      .maybeSingle();
    if (error) return null;
    return data;
  } catch { return null; }
}

async function dbUpsert(emailKey, attempts, lockUntil) {
  try {
    await supabase.from('login_attempts').upsert({
      email_key:  emailKey,
      attempts:   attempts,
      lock_until: lockUntil ? new Date(lockUntil).toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email_key' });
  } catch { /* non-blocking */ }
}

async function dbDelete(emailKey) {
  try {
    await supabase.from('login_attempts').delete().eq('email_key', emailKey);
  } catch { /* non-blocking */ }
}

// ─── Public API ────────────────────────────────────────────────────────────────

async function getLoginState(email) {
  const key = normalizeKey(email);
  if (!key) return { locked: false, remainingMs: 0 };
  const now = Date.now();

  const row = await dbGet(key);
  if (!row) {
    // DB not available or no record — try in-memory fallback
    const mem = _mem.get(key);
    if (!mem) return { locked: false, remainingMs: 0 };
    const attempts = (mem.attempts || []).filter(ts => now - ts <= LOGIN_LOCK_WINDOW_MS);
    if (attempts.length === 0 && (!mem.lockUntil || mem.lockUntil < now)) {
      _mem.delete(key); return { locked: false, remainingMs: 0 };
    }
    if (mem.lockUntil && mem.lockUntil > now) return { locked: true, remainingMs: mem.lockUntil - now };
    return { locked: false, remainingMs: 0 };
  }

  const attempts = (row.attempts || []).filter(ts => now - new Date(ts).getTime() <= LOGIN_LOCK_WINDOW_MS);
  const lockUntil = row.lock_until ? new Date(row.lock_until).getTime() : 0;
  if (attempts.length === 0 && lockUntil < now) {
    dbDelete(key); return { locked: false, remainingMs: 0 };
  }
  if (lockUntil > now) return { locked: true, remainingMs: lockUntil - now };
  return { locked: false, remainingMs: 0 };
}

async function registerLoginFailure(email) {
  const key = normalizeKey(email);
  if (!key) return { locked: false, remainingMs: 0, attempts: 0 };
  const now = Date.now();

  let attempts, lockUntil;
  const row = await dbGet(key);

  if (row) {
    attempts = (row.attempts || []).filter(ts => now - new Date(ts).getTime() <= LOGIN_LOCK_WINDOW_MS);
    attempts.push(new Date(now).toISOString());
    lockUntil = row.lock_until ? new Date(row.lock_until).getTime() : 0;
    if (attempts.length >= LOGIN_LOCK_MAX_ATTEMPTS) lockUntil = now + LOGIN_LOCK_DURATION_MS;
    await dbUpsert(key, attempts, lockUntil);
  } else {
    // Fall back to in-memory
    const mem = _mem.get(key) || { attempts: [], lockUntil: 0 };
    const memAttempts = (mem.attempts || []).filter(ts => now - ts <= LOGIN_LOCK_WINDOW_MS);
    memAttempts.push(now);
    let memLock = mem.lockUntil || 0;
    if (memAttempts.length >= LOGIN_LOCK_MAX_ATTEMPTS) memLock = now + LOGIN_LOCK_DURATION_MS;
    _mem.set(key, { attempts: memAttempts, lockUntil: memLock });
    attempts = memAttempts;
    lockUntil = memLock;
  }

  const locked = lockUntil > now;
  return { locked, remainingMs: locked ? lockUntil - now : 0, attempts: attempts.length };
}

async function clearLoginFailures(email) {
  const key = normalizeKey(email);
  if (!key) return;
  _mem.delete(key);
  await dbDelete(key);
}

module.exports = { getLoginState, registerLoginFailure, clearLoginFailures };
