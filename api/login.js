import { login, makeSessionCookie, clearSessionCookie } from './_auth.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    } else if (!body) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }
    const { email, password } = body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }
    const r = await login(email, password);
    if (!r.ok) return res.status(401).json(r);
    res.setHeader('Set-Cookie', await makeSessionCookie(r.session));
    return res.status(200).json({
      ok: true,
      user: {
        empCode: r.session.empCode,
        name: r.session.name,
        email: r.session.email,
        role: r.session.role,
      },
    });
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}
