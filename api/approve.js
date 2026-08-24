// Approval relay. Takes the decision from approve.html and forwards it to the
// Make.com approval webhook. Login required — the approver identity comes from
// the session, not from the client.

import { randomUUID } from 'crypto';
import { requireSession } from './_auth.js';

const APPROVAL_HOOK = process.env.IOU_APPROVAL_WEBHOOK_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  const session = await requireSession(req, res);
  if (!session) return;

  if (!APPROVAL_HOOK) {
    return res.status(500).json({ ok: false, error: 'IOU_APPROVAL_WEBHOOK_URL is not configured.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { id, action, stage, amount, notes } = body;
  const approver = session.name;

  if (!id || !action || !stage) {
    return res.status(400).json({ ok: false, error: 'Missing id, action, or stage.' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ ok: false, error: 'A valid amount is required.' });
  }
  if (action === 'reject' && !notes) {
    return res.status(400).json({ ok: false, error: 'A reason in Notes is required when rejecting.' });
  }

  try {
    const eventId = randomUUID();
    const idempotencyKey = `${id}-${stage}-${action}`;

    const r = await fetch(APPROVAL_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, action, stage,
        amount: Number(amount),
        approver: String(approver).trim(),
        notes: notes || '',
        eventId,
        eventType: 'iou.approval',
        idempotencyKey,
        timestamp: new Date().toISOString(),
        source: 'iou-web-app',
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Could not submit to the approval system: ' + err.message });
  }
}
