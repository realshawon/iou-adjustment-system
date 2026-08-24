// Returns the live IOU list for the tracker dashboard. Proxies the Make.com
// "IOU Dashboard Feed" webhook, which reads the SharePoint IOUTracker list.
//
// Open by design (2026-08-24): no login, and every IOU is visible to anyone
// with the URL — deliberately matching how the Expense tracker at
// expense.aksidcorp.com already works. This replaced a login-gated version
// that scoped the list to the signed-in user; Shawon asked for the two
// trackers to behave the same way.
const FEED_URL = 'https://hook.eu1.make.com/bj6amccm2xi4l8958io8r8ajh9cyjsel';

export default async function handler(req, res) {
  try {
    const upstream = await fetch(FEED_URL, { cache: 'no-store' });
    if (!upstream.ok) return res.status(502).json({ ok: false, error: `Data source error (${upstream.status}).` });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    const items = (Array.isArray(data) ? data : []).filter((r) => r && r.id);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Unexpected server error.' });
  }
}
