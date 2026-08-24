// Server-side IOU submission relay. Receives the form payload from the browser,
// validates it, injects identity from the session, and forwards to Make.com.
// The Make webhook URL never leaves the server.

import { randomUUID } from 'crypto';
import { requireSession } from './_auth.js';

const IOU_SUBMIT_WEBHOOK = process.env.IOU_SUBMIT_WEBHOOK_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const session = await requireSession(req, res);
  if (!session) return;

  if (!IOU_SUBMIT_WEBHOOK) {
    return res.status(500).json({ ok: false, error: 'IOU_SUBMIT_WEBHOOK_URL is not configured.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body) return res.status(400).json({ ok: false, error: 'Empty request body.' });

    const { id, employeeId, department, designation, date, category, vendor,
            description, breakdown, amount, submitterEmail, submitterWhatsapp,
            managerName, managerEmail, managerWhatsapp, receiptFiles,
            receiptFileName, receiptCount, submittedAt } = body;

    if (!id || !employeeId || !department || !date || !category || !description) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: 'Amount must be greater than 0.' });
    }
    if (!managerEmail || !/.+@.+\..+/.test(managerEmail)) {
      return res.status(400).json({ ok: false, error: 'A valid manager email is required.' });
    }

    const eventId = randomUUID();
    const idempotencyKey = `iou-submit-${id}`;

    const payload = {
      id,
      name: session.name,
      employeeId: session.empCode || employeeId,
      department,
      designation: designation || '',
      date,
      category,
      vendor: vendor || '',
      description,
      breakdown: breakdown || '',
      amount: Number(amount),
      submitterEmail: session.email || submitterEmail,
      submitterWhatsapp: submitterWhatsapp || '',
      managerName: managerName || '',
      managerEmail,
      managerWhatsapp: managerWhatsapp || '',
      receiptFileName: receiptFileName || '',
      receiptCount: receiptCount || 0,
      submittedAt: submittedAt || new Date().toISOString(),
      eventId,
      eventType: 'iou.submission',
      idempotencyKey,
      timestamp: new Date().toISOString(),
      source: 'iou-web-app',
    };

    if (receiptFiles && Array.isArray(receiptFiles) && receiptFiles.length) {
      payload.receiptFiles = receiptFiles;
      payload.receiptFileBase64 = receiptFiles[0].base64;
      payload.receiptContentType = receiptFiles[0].contentType;
    }

    const upstream = await fetch(IOU_SUBMIT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Backend error (${upstream.status}). ${text}`.trim() });
    }

    let result = {};
    try { result = await upstream.json(); } catch {}
    return res.status(200).json({ ok: true, itemId: result.itemId || '' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Unexpected server error.' });
  }
}
