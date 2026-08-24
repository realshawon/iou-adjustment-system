// Returns the live IOU list for the tracker dashboard. Proxies the Make.com
// "IOU Dashboard Feed" webhook, which reads the SharePoint IOUTracker list.
//
// Open by design (2026-08-24): no login, and every IOU is visible to anyone
// with the URL — deliberately matching how the Expense tracker at
// expense.aksidcorp.com already works.
//
// Cached (2026-08-24, Phase 1): the dashboard refreshes every 30s and each
// refresh used to cost 4 Make operations. Now one upstream call serves every
// request inside a 60s window, concurrent requests share a single in-flight
// call, and the last good payload is kept if Make goes down. See _feedcache.js.
// Nothing here is user-specific, so a single shared entry is safe.
import { getCachedFeed } from './_feedcache.js';

const FEED_URL = process.env.IOU_FEED_WEBHOOK_URL;
const TTL_MS = 60_000;

async function fetchFeed() {
  if (!FEED_URL) throw new Error('IOU_FEED_WEBHOOK_URL is not configured.');
  const upstream = await fetch(FEED_URL, { cache: 'no-store' });
  if (!upstream.ok) throw new Error(`Data source error (${upstream.status}).`);
  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); } catch { data = []; }
  return (Array.isArray(data) ? data : []).filter((r) => r && r.id);
}

export default async function handler(req, res) {
  try {
    // ?fresh=1 bypasses the TTL for the manual Refresh button, so a human who
    // explicitly asks for new data always gets it.
    const force = req.query?.fresh === '1';
    const r = await getCachedFeed('iou-feed', fetchFeed, { ttlMs: force ? 0 : TTL_MS });

    res.setHeader('Cache-Control', 'no-store');
    // Honest freshness signals for the UI: it shows "Live" only when the data
    // really is within the TTL, and surfaces the true age otherwise.
    res.setHeader('X-Feed-Fetched-At', new Date(r.fetchedAt).toISOString());
    res.setHeader('X-Feed-Age-Ms', String(r.ageMs));
    res.setHeader('X-Feed-Source', r.source);
    res.setHeader('X-Feed-Fresh', r.fresh ? '1' : '0');
    return res.status(200).json(r.data);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message || 'Could not read the IOU feed.' });
  }
}
