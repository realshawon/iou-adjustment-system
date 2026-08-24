import { getSession } from './_auth.js';

export default async function handler(req, res) {
  const s = await getSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  return res.status(200).json({
    ok: true,
    user: { empCode: s.empCode, name: s.name, email: s.email, role: s.role },
  });
}
