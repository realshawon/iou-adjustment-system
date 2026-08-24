// Shared auth for the IOU app (2026-08-23).
//
// Employees and approvers log in with the SAME email and password as
// erp.aksidcorp.com — no separate account list. Same Neon database, same
// `app_user` table, same bcrypt hash, same token_version revocation counter,
// and the SAME `AUTH_SECRET` as the ERP and the Health Benefit app — but a
// different cookie name (`iou_session`) so there is no cross-app session
// sharing. Unlike Health Benefit, an account here does NOT need to be linked
// to an employee record to log in, because approvers (Audit, Accounts, Top
// Management) may be functional/role accounts rather than individual
// employees.

import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import pg from 'pg';

let pool = null;
export function db() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

const COOKIE = 'iou_session';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

function getSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET not set — this app shares the ERP auth secret; set it in Vercel');
  return new TextEncoder().encode(s);
}

function readCookies(req) {
  const raw = req.headers?.cookie ?? '';
  const out = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Verify the current session cookie against the DB (live-revocation aware).
 * Returns { userId, employeeId, email, empCode, name, role } or null.
 */
export async function getSession(req) {
  const token = readCookies(req)[COOKIE];
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getSecret()));
  } catch { return null; }
  const userId = payload.uid;
  const tv = payload.tv;
  if (!userId) return null;
  const { rows } = await db().query(
    `SELECT u.id, u.email, u.active, u.token_version, u.employee_id, u.role,
            e.emp_code, e.full_name
     FROM app_user u LEFT JOIN employee e ON e.id = u.employee_id
     WHERE u.id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u || !u.active) return null;
  if ((tv ?? 1) !== u.token_version) return null;
  return {
    userId: Number(u.id),
    employeeId: u.employee_id ? Number(u.employee_id) : null,
    email: u.email,
    empCode: u.emp_code || null,
    name: u.full_name || u.email,
    role: u.role || null,
  };
}

/**
 * Try to log a user in with an ERP-style (email, password) pair. Same
 * failed-attempt lockout as the ERP: 5 bad tries → 15-minute lock. Unlike
 * Health Benefit, does NOT require an employee_id link — functional
 * approver accounts (audit@, accounts@, etc.) can sign in here too.
 */
export async function login(email, password) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const { rows } = await db().query(
    `SELECT u.id, u.email, u.password_hash, u.active, u.employee_id, u.token_version, u.role,
            u.failed_attempts, u.locked_until,
            e.emp_code, e.full_name
     FROM app_user u LEFT JOIN employee e ON e.id = u.employee_id
     WHERE (u.email = $1 OR e.emp_code = $1) AND u.active`,
    [normalized]
  );
  const u = rows[0];
  if (!u) return { ok: false, error: 'Invalid email or password.' };
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return { ok: false, error: 'Account is temporarily locked — try again in a few minutes.' };
  }
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) {
    await db().query(
      `UPDATE app_user SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= 5
                             THEN now() + interval '15 minutes' ELSE locked_until END
       WHERE id = $1`,
      [u.id]
    );
    return { ok: false, error: 'Invalid email or password.' };
  }
  await db().query(
    `UPDATE app_user SET last_login_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1`,
    [u.id]
  );
  return {
    ok: true,
    session: {
      userId: Number(u.id),
      employeeId: u.employee_id ? Number(u.employee_id) : null,
      email: u.email,
      empCode: u.emp_code || null,
      name: u.full_name || u.email,
      role: u.role || null,
      tv: u.token_version,
    },
  };
}

export async function makeSessionCookie(sess) {
  const jwt = await new SignJWT({ uid: sess.userId, tv: sess.tv })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${COOKIE_MAX_AGE}s`)
    .sign(getSecret());
  return `${COOKIE}=${encodeURIComponent(jwt)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export async function requireSession(req, res) {
  const s = await getSession(req);
  if (!s) {
    res.status(401).json({ ok: false, error: 'Not signed in.' });
    return null;
  }
  return s;
}
