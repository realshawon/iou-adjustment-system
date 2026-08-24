// Approval relay. Takes the decision from approve.html and forwards it to the
// Make.com approval webhook.
//
// Open by design (2026-08-24): no login. Whoever opens the approval link from
// their email can approve, and types their own name for the record — the same
// trust model the Expense tracker at expense.aksidcorp.com already uses.
// This replaced a version that required an ERP session and checked the
// signed-in identity against who the IOU was routed to; Shawon asked for the
// two systems to behave the same way.
const APPROVAL_HOOK = 'https://hook.eu1.make.com/qynuydubdyor015k3ogwyacay2lwefu5';

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

  const body = await readBody(req);
  const { id, action, stage, amount, notes, approver } = body || {};
  if (!id || !action || !stage) {
    return res.status(400).json({ ok: false, error: 'Missing id, action, or stage.' });
  }
  if (!approver || !String(approver).trim()) {
    return res.status(400).json({ ok: false, error: 'Your name is required so the approval can be recorded.' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ ok: false, error: 'A valid amount is required.' });
  }
  if (action === 'reject' && !notes) {
    return res.status(400).json({ ok: false, error: 'A reason in Notes is required when rejecting.' });
  }

  try {
    const r = await fetch(APPROVAL_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, action, stage,
        amount: Number(amount),
        approver: String(approver).trim(),
        notes: notes || '',
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Could not submit to the approval system: ' + err.message });
  }
}
