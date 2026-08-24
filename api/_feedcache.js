// Shared cache for Make.com feed webhooks (2026-08-24, Phase 1 / "Option A").
//
// Why: both dashboards auto-refresh every 30s, and every refresh was a full
// round trip — Make webhook -> SharePoint List Items (500 rows) -> aggregator
// -> response = 4 Make operations, re-reading the whole list whether or not
// anything had changed. One browser tab left open cost roughly 480 operations
// an hour. The scenarios' own run history showed calls seconds apart, and two
// firing in the same second, so concurrent refreshes were not deduplicated
// either.
//
// This does three things, all inside the app — no Make scenario is touched:
//   1. TTL   — one upstream fetch per TTL window instead of one per refresh.
//   2. Single-flight — concurrent requests share ONE in-flight upstream call.
//   3. Stale-on-error — the last good payload is kept and served if Make is
//      unavailable, so the dashboard degrades instead of breaking.
//
// SECURITY: this caches the RAW upstream payload only. Anything user-specific
// (per-user filtering, field redaction) must be applied by the caller AFTER
// reading from here, on every request. Never put a scoped response in here —
// the same entry is shared by every caller.
//
// Lives in module scope, which survives across invocations on a warm serverless
// instance. No database and no migration. Each concurrent instance keeps its own
// copy, so this reduces upstream calls sharply without being a global lock.

const DEFAULT_TTL_MS = 60_000;   // 60s, per the agreed Phase 1 scope
const STALE_MAX_MS = 15 * 60_000; // refuse to serve anything older than 15 min

const entries = new Map(); // key -> { data, fetchedAt, inflight }

/**
 * @param {string} key      cache key (one per upstream feed)
 * @param {() => Promise<any>} fetcher  performs the real upstream call
 * @param {{ttlMs?:number}} [opts]
 * @returns {Promise<{data:any, fetchedAt:number, ageMs:number, fresh:boolean,
 *                    source:'fresh'|'cache'|'stale-on-error', error:string|null}>}
 */
export async function getCachedFeed(key, fetcher, opts = {}) {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  let e = entries.get(key);
  if (!e) { e = { data: null, fetchedAt: 0, inflight: null }; entries.set(key, e); }

  const age = now - e.fetchedAt;

  // 1. Fresh enough — no upstream call at all.
  if (e.data !== null && age < ttl) {
    return { data: e.data, fetchedAt: e.fetchedAt, ageMs: age, fresh: true, source: 'cache', error: null };
  }

  // 2. Someone else is already fetching — join them rather than starting a
  //    second identical call. This is what stops two refreshes landing in the
  //    same second from becoming two Make runs.
  if (e.inflight) {
    try {
      const data = await e.inflight;
      const a = Date.now() - e.fetchedAt;
      return { data, fetchedAt: e.fetchedAt, ageMs: a, fresh: a < ttl, source: 'cache', error: null };
    } catch (err) {
      // The shared call failed; fall through to the stale/error handling below.
      if (e.data !== null && (Date.now() - e.fetchedAt) < STALE_MAX_MS) {
        return { data: e.data, fetchedAt: e.fetchedAt, ageMs: Date.now() - e.fetchedAt, fresh: false, source: 'stale-on-error', error: err.message };
      }
      throw err;
    }
  }

  // 3. We are the one to refresh it.
  e.inflight = (async () => {
    const data = await fetcher();
    e.data = data;
    e.fetchedAt = Date.now();
    return data;
  })();

  try {
    const data = await e.inflight;
    return { data, fetchedAt: e.fetchedAt, ageMs: 0, fresh: true, source: 'fresh', error: null };
  } catch (err) {
    // Upstream failed. Serve the last good payload if we have one and it is not
    // absurdly old — a slightly stale dashboard beats a broken one.
    if (e.data !== null && (Date.now() - e.fetchedAt) < STALE_MAX_MS) {
      return {
        data: e.data, fetchedAt: e.fetchedAt, ageMs: Date.now() - e.fetchedAt,
        fresh: false, source: 'stale-on-error', error: err.message,
      };
    }
    throw err;
  } finally {
    e.inflight = null;
  }
}

/** Test/debug helper — drops everything so a test starts from a known state. */
export function _resetFeedCache() { entries.clear(); }
