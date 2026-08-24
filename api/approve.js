// Server-side approval relay (2026-08-23). Login required.
//
// Before this, approve.html let anyone with the email link type ANY name in
// as "approver" and submit — no verification that the person clicking was
// actually the person the approval was routed to. Now the approver's
// identity comes from their signed-in ERP session, not a free-text field,
// and this endpoint checks that identity against who the IOU is actually
// currently routed to before relaying the decision to Make.com.
import { getSession, db } from './_auth.js';

const FEED_URL = 'https://hook.eu1.make.com/bj6amccm2xi4l8958io8r8ajh9cyjsel';
const APPROVAL_HOOK = 'https://hook.eu1.make.com/qynuydubdyor015k3ogwyacay2lwefu5';
const OVERRIDE_ROLES = new Set(['superadmin', 'admin']);
// Stages 2-4 always route to the same fixed role inboxes (set on every IOU by
// the intake flow); only stage 1 varies per-submission (whichever Concern
// Department Head the submitter named).
const FIXED_STAGE_EMAIL = { 2: 'audit@aksidcorp.com', 3: 'accounts@aksidcorp.com', 4: 'saud@aksidcorp.com' };

async function roleFor(userId) {
  try {
    const { rows } = await db().query(`SELECT role FROM app_user WHERE id = $1`, [userId]);
    return rows[0]?.role ?? null;
  } catch { return null; }
}

async function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (body) return body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  const session = await getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const body = await readBody(req);
  const { id, action, stage, amount, notes } = body || {};
  if (!id || !action || !stage) {
    return res.status(400).json({ ok: false, error: 'Missing id, action, or stage.' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ ok: false, error: 'A valid amount is required.' });
  }
  if (action === 'reject' && !notes) {
    return res.status(400).json({ ok: false, error: 'A reason in Notes is required when rejecting.' });
  }

  const role = await roleFor(session.userId);
  const isOverride = role && OVERRIDE_ROLES.has(role);

  if (!isOverride) {
    // Confirm this IOU is actually currently routed to the signed-in person
    // before letting them approve/reject it.
    let item;
    try {
      const upstream = await fetch(FEED_URL, { cache: 'no-store' });
      const data = await upstream.json();
      const items = Array.isArray(data) ? data : [];
      item = items.find((r) => String(r.id) === String(id));
    } catch {
      return res.status(502).json({ ok: false, error: 'Could not verify approval routing right now — try again shortly.' });
    }
    if (!item) return res.status(404).json({ ok: false, error: 'This IOU could not be found — it may have already moved on.' });

    const email = String(session.email || '').trim().toLowerCase();
    const stageNum = Number(stage);
    const expected = String(FIXED_STAGE_EMAIL[stageNum] || item.managerEmail || '').trim().toLowerCase();
    if (!expected || expected !== email) {
      return res.status(403).json({ ok: false, error: 'This IOU is not currently awaiting your approval.' });
    }
  }

  try {
    const r = await fetch(APPROVAL_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, action, stage,
        amount: Number(amount),
        approver: session.name,
        approverEmail: session.email,
        notes: notes || '',
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Could not submit to the approval system: ' + err.message });
  }
}
