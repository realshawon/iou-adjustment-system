// Returns the live IOU list for the tracker dashboard, scoped to the signed-in
// user. Proxies the Make.com "IOU Dashboard Feed" webhook (reads the
// SharePoint IOUTracker list). Login required (2026-08-23).
//
// Visibility rule: approver roles (audit/accounts/dept_head/topmgmt/admin/
// superadmin) see every IOU, because that's the point of their dashboard.
// Everyone else only sees IOUs where they are the submitter, or where the
// IOU is currently awaiting their approval (matched by email against
// managerEmail / currentApproverEmail).
import { getSession, db } from './_auth.js';

const FEED_URL = 'https://hook.eu1.make.com/bj6amccm2xi4l8958io8r8ajh9cyjsel';
const APPROVER_ROLES = new Set(['superadmin', 'admin', 'audit', 'accounts', 'dept_head', 'topmgmt', 'hr']);
// Stages 2-4 always route to the same fixed role inboxes; only stage 1 varies
// per-submission. Mirrors api/approve.js.
const FIXED_STAGE_EMAIL = { 2: 'audit@aksidcorp.com', 3: 'accounts@aksidcorp.com', 4: 'saud@aksidcorp.com' };

async function roleFor(userId) {
  try {
    const { rows } = await db().query(`SELECT role FROM app_user WHERE id = $1`, [userId]);
    return rows[0]?.role ?? null;
  } catch { return null; }
}

export default async function handler(req, res) {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const role = await roleFor(session.userId);
  const isApprover = role && APPROVER_ROLES.has(role);

  try {
    const upstream = await fetch(FEED_URL, { cache: 'no-store' });
    if (!upstream.ok) return res.status(502).json({ ok: false, error: `Data source error (${upstream.status}).` });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    let items = Array.isArray(data) ? data : [];
    items = items.filter((r) => r && r.id);

    if (!isApprover) {
      const email = String(session.email || '').trim().toLowerCase();
      items = items.filter((r) => {
        const submitter = String(r.submitterEmail || '').trim().toLowerCase();
        const manager = String(r.managerEmail || '').trim().toLowerCase();
        const currentApprover = String(FIXED_STAGE_EMAIL[Number(r.stage)] || manager || '').trim().toLowerCase();
        return submitter === email || currentApprover === email;
      });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Unexpected server error.' });
  }
}
