import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export class StoreConflict extends Error {
}
export class SessionAccessError extends Error {
}
const clamp01 = (n) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const hours = (ms) => ms / 3_600_000;
const toEntry = (p, rank) => ({
    id: p.id,
    version: p.version,
    rank,
    authorId: p.authorId,
});
function assertApproved(cfg) {
    if (process.env.NODE_ENV === "production" && cfg.status !== "approved") {
        throw new Error("ranking config is experimental; refusing to run in production");
    }
    const positive = [cfg.temperature, cfg.priorStrength, cfg.freshnessTauH, cfg.fatigueK,
        cfg.exposureHalfLifeH, cfg.widenFactor, cfg.crossWidenFactor, cfg.maxOrder,
        cfg.maxServeScan, cfg.view.receiptTtlMs, cfg.view.viewportCapacity];
    if (positive.some(x => !Number.isFinite(x) || x <= 0) ||
        !Number.isFinite(cfg.priorRate) || cfg.priorRate < 0 || cfg.priorRate > 1 ||
        !Number.isFinite(cfg.seenBlock) || cfg.seenBlock < 0 ||
        !Number.isFinite(cfg.futureSkewMs) || cfg.futureSkewMs < 0 ||
        !Number.isSafeInteger(cfg.maxTopics) || cfg.maxTopics < 0 ||
        !Number.isSafeInteger(cfg.minPool) || cfg.minPool < 0 ||
        !Number.isSafeInteger(cfg.minLocalPool) || cfg.minLocalPool < 0 ||
        !Number.isSafeInteger(cfg.maxPerAuthor) || cfg.maxPerAuthor < 1 ||
        !Number.isSafeInteger(cfg.diversityWindow) || cfg.diversityWindow < 1 ||
        !Number.isSafeInteger(cfg.maxServesPerSession) || cfg.maxServesPerSession < 1 ||
        !Number.isSafeInteger(cfg.maxOrder) || !Number.isSafeInteger(cfg.maxServeScan) ||
        !Number.isSafeInteger(cfg.view.maxBatch) || cfg.view.maxBatch < 1 ||
        !Number.isFinite(cfg.view.minVisibleMs) || cfg.view.minVisibleMs < 0 ||
        !Number.isFinite(cfg.view.minVisibleFraction) || cfg.view.minVisibleFraction < 0 || cfg.view.minVisibleFraction > 1 ||
        !Number.isFinite(cfg.view.slackMs) || cfg.view.slackMs < 0 ||
        Object.values(cfg.budget).some(x => !Number.isSafeInteger(x) || x < 0) ||
        Object.values(cfg.localShare).some(x => !Number.isFinite(x) || x < 0 || x > 1) ||
        Object.values(cfg.weights).some(w => Object.values(w).some(x => !Number.isFinite(x) || x < 0))) {
        throw new RangeError("invalid experimental feed configuration");
    }
}
// Runs an observer hook without letting it affect the caller, then reports what it threw.
function report(deps, where, err) {
    try {
        deps.onError?.(where, err);
    }
    catch {
        // the error reporter must not fail delivery either
    }
}
function runHook(deps, where, fn) {
    try {
        void Promise.resolve(fn()).catch(err => report(deps, where, err));
    }
    catch (err) {
        report(deps, where, err);
    }
}
// ---------- signals ----------
function decayedCount(e, now, halfLifeH) {
    if (!e)
        return 0;
    return e.count * 0.5 ** (hours(Math.max(0, now - e.lastViewedAt)) / halfLifeH);
}
const bumpExposure = (prev, at, halfLifeH) => ({
    count: decayedCount(prev, at, halfLifeH) + 1,
    lastViewedAt: at,
});
const exposureOf = (viewer, postId, now, cfg) => decayedCount(Object.hasOwn(viewer.exposures, postId) ? viewer.exposures[postId] : undefined, now, cfg.exposureHalfLifeH);
const freshness = (ageH, tauH) => ageH < 0 ? 0 : Math.exp(-ageH / tauH);
const smoothedQuality = (p, cfg) => clamp01((p.satisfied + cfg.priorRate * cfg.priorStrength) /
    (p.impressions + cfg.priorStrength));
function relevanceScore(s, w) {
    return (w.interest * clamp01(s.interest) +
        w.community * clamp01(s.community) +
        w.quality * clamp01(s.quality) +
        w.freshness * clamp01(s.freshness) -
        w.fatigue * clamp01(s.fatigue));
}
function computeSignals(post, viewer, interests, ctx, cfg) {
    const topics = new Set(post.topics);
    let matches = 0;
    for (const t of topics)
        if (interests.has(t))
            matches++;
    const x = exposureOf(viewer, post.id, ctx.now, cfg);
    return {
        interest: topics.size ? matches / topics.size : 0,
        community: post.regionId === viewer.regionId ? 1 : 0,
        quality: smoothedQuality(post, cfg),
        freshness: freshness(hours(ctx.now - post.createdAt), cfg.freshnessTauH),
        fatigue: x / (x + cfg.fatigueK),
    };
}
// ---------- eligibility ----------
// Fail-closed: missing, malformed or unknown data denies. Time rules run on the clock in `ctx`,
// which delivery takes from the server, never from the client. Square conversation is kept out
// of feeds by `feedEligible`; it stays reachable inside Square through Square's own path.
function validStrings(x) {
    return Array.isArray(x) && x.every(v => typeof v === "string" && v.trim().length > 0);
}
// Validate ranking-specific fields before the scoring engine sees an index row or authority row.
function validRankablePost(p) {
    return !!p && typeof p.id === "string" && p.id.length > 0 &&
        typeof p.authorId === "string" && p.authorId.length > 0 &&
        typeof p.regionId === "string" && p.regionId.length > 0 &&
        validStrings(p.topics) &&
        Number.isSafeInteger(p.version) && p.version >= 0 &&
        Number.isSafeInteger(p.impressions) && p.impressions >= 0 &&
        Number.isSafeInteger(p.satisfied) && p.satisfied >= 0 && p.satisfied <= p.impressions &&
        Number.isFinite(p.createdAt);
}
function validPostPolicy(p) {
    if (!p || !p.id || !p.authorId || !Number.isFinite(p.createdAt) ||
        typeof p.feedEligible !== "boolean" ||
        p.expiresAt === undefined || (p.expiresAt !== null && !Number.isFinite(p.expiresAt)) ||
        p.minAge === undefined || (p.minAge !== null && (!Number.isSafeInteger(p.minAge) || p.minAge < 0)))
        return false;
    const g = p.geo;
    if (g === undefined)
        return false;
    if (g !== null && (typeof g !== "object" || Array.isArray(g) ||
        (g.allow === undefined && g.deny === undefined) ||
        (g.allow !== undefined && !validStrings(g.allow)) ||
        (g.deny !== undefined && !validStrings(g.deny))))
        return false;
    return true;
}
export function createPolicyGate(futureSkewMs) {
    return (viewer, ctx) => {
        const age = viewer.age;
        const complete = validStrings(viewer.blockedAuthors) &&
            validStrings(viewer.blockedBy) &&
            validStrings(viewer.hiddenAuthors) &&
            validStrings(viewer.hiddenPosts) &&
            typeof viewer.id === "string" && viewer.id.length > 0 &&
            (age === null || (Number.isSafeInteger(age) && age >= 0)) &&
            Number.isFinite(ctx.now);
        if (!complete)
            return () => "incomplete";
        const blocked = new Set(viewer.blockedAuthors);
        const blockedBy = new Set(viewer.blockedBy);
        const hiddenAuthors = new Set(viewer.hiddenAuthors);
        const hiddenPosts = new Set(viewer.hiddenPosts);
        const j = typeof viewer.jurisdiction === "string" ? viewer.jurisdiction : "";
        return post => {
            if (!post || typeof post.id !== "string" || !post.id)
                return "incomplete";
            if (typeof post.authorId !== "string" || !post.authorId)
                return "incomplete";
            if (!validPostPolicy(post) || post.moderation == null || post.visibility == null) {
                return "incomplete";
            }
            if (!Number.isFinite(post.createdAt))
                return "incomplete";
            if (typeof post.feedEligible !== "boolean")
                return "incomplete";
            if (post.expiresAt === undefined || (post.expiresAt !== null && !Number.isFinite(post.expiresAt))) {
                return "incomplete";
            }
            if (post.minAge === undefined ||
                (post.minAge !== null && (!Number.isSafeInteger(post.minAge) || post.minAge < 0))) {
                return "incomplete";
            }
            const g = post.geo;
            if (g !== null) {
                const bad = typeof g !== "object" || Array.isArray(g) ||
                    (g.allow !== undefined && !validStrings(g.allow)) ||
                    (g.deny !== undefined && !validStrings(g.deny)) ||
                    (g.allow === undefined && g.deny === undefined);
                if (bad)
                    return "incomplete";
            }
            if (post.moderation !== "approved")
                return "moderation";
            if (!post.feedEligible)
                return "not_feed";
            if (post.createdAt > ctx.now + futureSkewMs)
                return "scheduled";
            if (post.expiresAt !== null && post.expiresAt <= ctx.now)
                return "expired";
            if (blocked.has(post.authorId) || blockedBy.has(post.authorId))
                return "blocked";
            if (hiddenAuthors.has(post.authorId) || hiddenPosts.has(post.id))
                return "hidden";
            // Preserve owner-only private access from the 12:41 baseline. A private root
            // never passes this gate for any other viewer; serving always revalidates
            // using authoritative viewer policy and the actual requester identity.
            if (post.visibility === "private") {
                if (post.authorId !== viewer.id)
                    return "privacy";
            }
            else if (post.visibility !== "public") {
                return "privacy";
            }
            if (post.minAge !== null && (age === null || age < post.minAge))
                return "age";
            if (g !== null) {
                if (!j)
                    return "geo";
                if (g.deny?.includes(j))
                    return "geo";
                if (g.allow && !g.allow.includes(j))
                    return "geo";
            }
            return "ok";
        };
    };
}
function admissible(posts, allow) {
    const ids = new Set();
    return posts.filter(p => {
        if (!validRankablePost(p) || allow(p) !== "ok" || ids.has(p.id))
            return false;
        ids.add(p.id);
        return true;
    });
}
class MinHeap {
    a = [];
    get size() { return this.a.length; }
    push(x) {
        const a = this.a;
        a.push(x);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].idx <= a[i].idx)
                break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop() {
        const a = this.a;
        if (!a.length)
            return undefined;
        const top = a[0];
        const last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].idx < a[m].idx)
                    m = l;
                if (r < a.length && a[r].idx < a[m].idx)
                    m = r;
                if (m === i)
                    break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}
// Prefers: in any `window` consecutive positions an author appears at most `max` times.
// Eligible posts are never dropped. When only saturated authors remain (sparse inventory),
// the limit is relaxed minimally (least-represented author first) and the position where
// relaxation began is returned so the override is visible downstream.
// `prior` holds the authors of items already placed before `ordered`, for the window at the seam.
// O(n log n): only each author's earliest remaining post can be next, so a heap of those heads
// (for authors under the cap) replaces the repeated scan and splice. When the heap is empty every
// remaining author is at the cap, so at most `window` authors remain and the relaxed scan is small.
export function diversify(ordered, max, window, prior = []) {
    const cap = Math.max(1, Math.floor(max));
    const W = Math.max(0, window - 1);
    const queues = new Map();
    ordered.forEach((p, i) => {
        const q = queues.get(p.authorId);
        if (q)
            q.idx.push(i);
        else
            queues.set(p.authorId, { idx: [i], at: 0 });
    });
    const head = (a) => {
        const q = queues.get(a);
        return q ? q.idx[q.at] : -1;
    };
    const seq = prior.slice(Math.max(0, prior.length - W));
    const counts = new Map();
    for (const a of seq)
        counts.set(a, (counts.get(a) ?? 0) + 1);
    const count = (a) => counts.get(a) ?? 0;
    const heap = new MinHeap();
    for (const a of queues.keys())
        if (count(a) < cap)
            heap.push({ idx: head(a), author: a });
    const out = [];
    let relaxedFrom = null;
    while (out.length < ordered.length) {
        let author;
        for (let top = heap.pop(); top; top = heap.pop()) {
            if (head(top.author) === top.idx && count(top.author) < cap) {
                author = top.author;
                break;
            }
        }
        if (author === undefined) {
            relaxedFrom ??= out.length;
            let best = Infinity;
            let bestIdx = Infinity;
            for (const [a, q] of queues) {
                const c = count(a);
                const h = q.idx[q.at];
                if (c < best || (c === best && h < bestIdx)) {
                    best = c;
                    bestIdx = h;
                    author = a;
                }
            }
        }
        const a = author;
        const q = queues.get(a);
        out.push(ordered[q.idx[q.at]]);
        if (++q.at >= q.idx.length)
            queues.delete(a);
        seq.push(a);
        const c = count(a) + 1;
        counts.set(a, c);
        if (queues.has(a) && c < cap)
            heap.push({ idx: head(a), author: a });
        const leaving = seq.length - 1 - W;
        if (leaving >= 0) {
            const b = seq[leaving];
            const before = count(b);
            counts.set(b, before - 1);
            if (before >= cap && before - 1 < cap && queues.has(b)) {
                heap.push({ idx: head(b), author: b });
            }
        }
    }
    return { order: out, relaxedFrom };
}
// Quota-aware diversification: a local post receives priority only when the configured
// prefix floor is due AND the author's sliding-window cap permits it. Safety and author
// diversity have precedence when those constraints are mathematically incompatible.
// Two heaps preserve score order among eligible local and cross-region author heads.
export function diversifyWithLocalQuota(ordered, max, window, regionId, share, prior = []) {
    if (clamp01(share) === 0)
        return diversify(ordered, max, window, prior);
    const s = clamp01(share), cap = Math.max(1, Math.floor(max)), W = Math.max(0, window - 1);
    const queues = new Map();
    ordered.forEach((p, i) => {
        const q = queues.get(p.authorId);
        if (q)
            q.idx.push(i);
        else
            queues.set(p.authorId, { idx: [i], at: 0 });
    });
    const head = (a) => {
        const q = queues.get(a);
        return q ? q.idx[q.at] : -1;
    };
    const seq = prior.slice(Math.max(0, prior.length - W));
    const counts = new Map();
    for (const a of seq)
        counts.set(a, (counts.get(a) ?? 0) + 1);
    const count = (a) => counts.get(a) ?? 0;
    const localHeap = new MinHeap(), otherHeap = new MinHeap();
    const enqueue = (a) => {
        const i = head(a);
        if (i >= 0 && count(a) < cap) {
            (ordered[i].regionId === regionId ? localHeap : otherHeap).push({ idx: i, author: a });
        }
    };
    const take = (h) => {
        for (let x = h.pop(); x; x = h.pop()) {
            if (head(x.author) === x.idx && count(x.author) < cap)
                return x;
        }
        return undefined;
    };
    for (const a of queues.keys())
        enqueue(a);
    const out = [];
    let localCount = 0, relaxedFrom = null;
    while (out.length < ordered.length) {
        const l = take(localHeap), o = take(otherHeap);
        const owed = Math.floor(s * (out.length + 1) + 1e-9) > localCount;
        let chosen;
        if (owed && l)
            chosen = l;
        else if (l && o)
            chosen = l.idx < o.idx ? l : o;
        else
            chosen = l ?? o;
        if (chosen !== l && l)
            localHeap.push(l);
        if (chosen !== o && o)
            otherHeap.push(o);
        if (!chosen) {
            relaxedFrom ??= out.length;
            let best = Infinity, bestIdx = Infinity;
            for (const [a, q] of queues) {
                const c = count(a), i = q.idx[q.at];
                if (c < best || (c === best && i < bestIdx)) {
                    best = c;
                    bestIdx = i;
                    chosen = { idx: i, author: a };
                }
            }
        }
        const x = chosen;
        const p = ordered[x.idx];
        out.push(p);
        if (p.regionId === regionId)
            localCount++;
        const q = queues.get(x.author);
        if (++q.at >= q.idx.length)
            queues.delete(x.author);
        seq.push(x.author);
        counts.set(x.author, count(x.author) + 1);
        enqueue(x.author);
        const leaving = seq.length - 1 - W;
        if (leaving >= 0) {
            const a = seq[leaving], before = count(a);
            counts.set(a, before - 1);
            if (before >= cap && before - 1 < cap)
                enqueue(a);
        }
    }
    return { order: out, relaxedFrom };
}
// Diversifies each tier independently so a later tier can never jump ahead of an earlier one.
// The author window continues across tier seams, and the first relaxed position is reported
// against the concatenated order.
function diversifyTiers(tiers, cfg, prior = [], local) {
    const out = [];
    const authors = prior.slice();
    let relaxedFrom = null;
    for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        if (!tier.length)
            continue;
        const d = i === 0 && local
            ? diversifyWithLocalQuota(tier, cfg.maxPerAuthor, cfg.diversityWindow, local.regionId, local.share, authors)
            : diversify(tier, cfg.maxPerAuthor, cfg.diversityWindow, authors);
        if (relaxedFrom === null && d.relaxedFrom !== null) {
            relaxedFrom = out.length + d.relaxedFrom;
        }
        out.push(...d.order);
        authors.push(...d.order.map(p => p.authorId));
    }
    return { order: out, relaxedFrom };
}
// ---------- local share ----------
// Scores decide who ranks high, but a score can never promise a viewer's own region a place:
// strong posts from elsewhere can outrank every local one. This makes the preference explicit.
// Every prefix of the result holds at least floor(share * length) local posts, as long as local
// posts remain; otherwise posts keep their given order. Region is not a boundary: when either
// side runs out, the other fills the rest. Run it before `diversify`, which may shift positions
// slightly to honor the author window.
export function withLocalShare(posts, regionId, share) {
    const s = clamp01(share);
    if (s === 0)
        return posts;
    const local = [];
    const other = [];
    posts.forEach((p, i) => (p.regionId === regionId ? local : other).push(i));
    if (!local.length || !other.length)
        return posts;
    const out = [];
    let l = 0;
    let o = 0;
    while (l < local.length || o < other.length) {
        const owed = Math.floor(s * (out.length + 1) + 1e-9) - l; // local posts the prefix is short by
        const takeLocal = l >= local.length ? false :
            o >= other.length ? true :
                owed > 0 ? true :
                    local[l] < other[o];
        out.push(posts[takeLocal ? local[l++] : other[o++]]);
    }
    return out;
}
// Deterministic reference ranking (tests, debugging)
export function rankDlopeFeed(posts, viewer, ctx, deps) {
    const { cfg, gate } = deps;
    const w = cfg.weights[ctx.surface];
    const interests = new Set(viewer.interests);
    const scored = admissible(posts, gate(viewer, ctx)).map(post => ({
        post,
        score: relevanceScore(computeSignals(post, viewer, interests, ctx, cfg), w),
    }));
    scored.sort((a, b) => b.score - a.score ||
        b.post.createdAt - a.post.createdAt ||
        byId(a.post, b.post));
    assertApproved(cfg);
    return diversifyWithLocalQuota(scored.map(s => s.post), cfg.maxPerAuthor, cfg.diversityWindow, viewer.regionId, cfg.localShare[ctx.surface]).order;
}
// ---------- sampling ----------
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// Gumbel-perturbed ordering. Lower `rankOf` always comes first.
function orderSample(posts, viewer, ctx, cfg, rng, rankOf) {
    const w = cfg.weights[ctx.surface];
    const interests = new Set(viewer.interests);
    const keyed = posts.map(post => {
        const score = relevanceScore(computeSignals(post, viewer, interests, ctx, cfg), w);
        const u = Math.min(Math.max(rng(), 1e-9), 1 - 1e-9);
        return { post, rank: rankOf(post), key: score / cfg.temperature - Math.log(-Math.log(u)) };
    });
    keyed.sort((a, b) => a.rank - b.rank || b.key - a.key || byId(a.post, b.post));
    return keyed.map(k => k.post);
}
// Cross-region candidates are always retrieved. Their budget grows on its own when local
// content runs thin.
function buckets(index, viewer, cfg, ctx, gate) {
    const scope = { viewer, ctx, gate };
    const b = cfg.budget;
    const topics = [...new Set(viewer.interests)].slice(0, cfg.maxTopics);
    return [
        { key: "region", budget: b.region, cross: false, fetch: n => index.region(viewer.regionId, n, scope) },
        { key: "cross", budget: b.crossRegion, cross: true, fetch: n => index.crossRegion(viewer.regionId, n, scope) },
        { key: "trending", budget: b.trending, cross: false, fetch: n => index.trending(n, scope) },
        { key: "newest", budget: b.newest, cross: false, fetch: n => index.newest(n, scope) },
        { key: "unproven", budget: b.unproven, cross: false, fetch: n => index.unproven(n, scope) },
        ...topics.map(t => ({
            key: `topic:${t}`,
            budget: b.topic,
            cross: false,
            fetch: (n) => index.topic(t, n, scope),
        })),
    ];
}
// Fetches every bucket at the size `scale` asks for. A bucket that came back short already
// returned everything it has, so it is never asked again: only full buckets can yield more.
// Results accumulate in `got`, so a widening pass reuses the first pass instead of replacing it.
async function fetchBuckets(plan, got, scale) {
    await Promise.all(plan.map(async (b) => {
        const prev = got.get(b.key);
        if (prev && !prev.full)
            return;
        const limit = Math.ceil(b.budget * (b.cross ? scale.cross : scale.base));
        if (prev && limit <= prev.limit)
            return;
        const posts = await b.fetch(limit);
        got.set(b.key, { limit, posts, full: posts.length >= limit });
    }));
}
function candidates(got) {
    // Async retrieval completion order must not change which candidate receives a seeded
    // random draw. Resolve duplicate IDs by highest content version, then stable bucket order.
    const unique = new Map();
    for (const [, f] of [...got.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        for (const p of f.posts) {
            const current = unique.get(p.id);
            if (!current || (Number.isSafeInteger(p.version) && p.version > current.version))
                unique.set(p.id, p);
        }
    }
    return [...unique.values()].sort(byId);
}
function assertOwner(s, viewer) {
    if (s.viewerId !== viewer.id)
        throw new SessionAccessError("session not found");
}
// Same error for "missing" and "someone else's", so ids cannot be probed.
export async function loadSession(deps, sessionId, viewer) {
    const s = await deps.store.load(sessionId);
    if (!s || s.viewerId !== viewer.id)
        throw new SessionAccessError("session not found");
    return s;
}
// Ranks candidates for one refresh. Reads only; nothing is persisted here. The store is the
// source of truth for exposures, so whatever `viewer.exposures` held on entry is replaced.
export async function buildRanking(deps, viewer, ctx, id, seed, refresh) {
    const { index, gate, cfg, store } = deps;
    assertApproved(cfg);
    viewer.exposures = await store.exposures(viewer.id);
    const { served, claimed } = await store.history(id);
    // Index snapshots are only a pre-filter; nextPage re-checks against the authority.
    const allow = gate(viewer, ctx);
    const exposure = (p) => exposureOf(viewer, p.id, ctx.now, cfg);
    const blocked = (p) => exposure(p) >= cfg.seenBlock;
    const attempts = [
        ["fresh", { base: 1, cross: 1 }],
        ["widened", { base: cfg.widenFactor, cross: cfg.crossWidenFactor }],
    ];
    const plan = buckets(index, viewer, cfg, ctx, gate);
    const got = new Map();
    let tier = "fresh";
    let pool = [];
    for (const [t, scale] of attempts) {
        // Every bucket already returned all it has: widening cannot add a post.
        if (got.size && ![...got.values()].some(f => f.full))
            break;
        await fetchBuckets(plan, got, scale);
        pool = admissible(candidates(got), allow).filter(p => !served.has(p.id) && !blocked(p));
        tier = t;
        const local = pool.filter(p => p.regionId === viewer.regionId).length;
        if (pool.length >= cfg.minPool && local >= cfg.minLocalPool)
            break;
    }
    const rank = new Map(pool.map(p => [p.id, 0]));
    const rng = mulberry32(seed * 1000 + refresh);
    const fresh = orderSample(pool, viewer, ctx, cfg, rng, () => 0);
    const tiers = [fresh];
    let size = fresh.length;
    // Viewer history above the block threshold, not yet served this session.
    if (size < cfg.minPool) {
        const ids = Object.keys(viewer.exposures).filter(pid => !served.has(pid) && exposureOf(viewer, pid, ctx.now, cfg) >= cfg.seenBlock);
        const history = admissible(await index.byIds(ids), allow);
        if (history.length) {
            for (const p of history)
                rank.set(p.id, 1 + Math.floor(exposure(p)));
            const sampled = orderSample(history, viewer, ctx, cfg, rng, p => Math.floor(exposure(p)));
            tiers.push(sampled);
            size += sampled.length;
            tier = "recycled";
        }
    }
    // Served this session but never claimed as viewed, capped per post.
    if (size < cfg.minPool) {
        const ids = [...served]
            .filter(([pid, s]) => !claimed.has(pid) && s.count < cfg.maxServesPerSession)
            .map(([pid]) => pid);
        const again = admissible(await index.byIds(ids), allow);
        if (again.length) {
            for (const p of again)
                rank.set(p.id, 1000 + served.get(p.id).lastRefresh);
            const sampled = orderSample(again, viewer, ctx, cfg, rng, p => served.get(p.id).lastRefresh);
            tiers.push(sampled);
            tier = "reshown";
        }
    }
    const diversified = diversifyTiers(tiers, cfg, [], { regionId: viewer.regionId, share: cfg.localShare[ctx.surface] });
    const order = diversified.order.slice(0, cfg.maxOrder);
    const relaxedFrom = diversified.relaxedFrom !== null && diversified.relaxedFrom < order.length
        ? diversified.relaxedFrom
        : null;
    if (!order.length)
        tier = "exhausted";
    return { tier, order: order.map(p => toEntry(p, rank.get(p.id))), relaxedFrom };
}
// Starts a new session. Always a fresh id, inserted only if absent: it can never overwrite.
export async function openSession(deps, viewer, ctx, opts) {
    const id = randomUUID();
    const built = await buildRanking(deps, viewer, ctx, id, opts.seed, 0);
    const session = {
        id,
        viewerId: viewer.id,
        seed: opts.seed,
        startedAt: ctx.now,
        refresh: 0,
        rev: 0,
        cursor: 0,
        ...built,
    };
    await deps.store.create(session);
    return session;
}
// Moves a session to its next refresh. Checks ownership, then replaces the stored session only
// if it is still exactly at `from` (refresh, cursor, rev). On StoreConflict, reload and retry.
export async function advanceSession(deps, from, viewer, ctx) {
    assertOwner(from, viewer);
    const built = await buildRanking(deps, viewer, ctx, from.id, from.seed, from.refresh + 1);
    const next = { ...from, refresh: from.refresh + 1, rev: 0, cursor: 0, ...built };
    await deps.store.replace(next, { refresh: from.refresh, cursor: from.cursor, rev: from.rev });
    return next;
}
// Serves authoritative records only. Cached entries supply order, never content.
// Throws, serving nothing, if authoritative state or the store is unavailable or conflicts.
export async function nextPage(deps, s, viewer, ctx, pageSize) {
    assertOwner(s, viewer);
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
        throw new RangeError("pageSize must be a positive integer");
    }
    const { authority, store, cfg } = deps;
    const policy = await authority.viewer(viewer.id);
    const allow = deps.gate({ ...policy, id: viewer.id }, ctx);
    const picked = [];
    let cursor = s.cursor;
    let scanned = 0;
    while (picked.length < pageSize && cursor < s.order.length && scanned < cfg.maxServeScan) {
        const batch = s.order.slice(cursor, cursor + pageSize * 2);
        const auth = await authority.posts(batch.map(e => e.id));
        for (const entry of batch) {
            if (picked.length === pageSize || scanned >= cfg.maxServeScan)
                break;
            const index = cursor++;
            scanned++;
            const post = auth.get(entry.id);
            if (!post || post.id !== entry.id || !validRankablePost(post) || allow(post) !== "ok" ||
                picked.some(x => x.post.id === post.id))
                continue;
            picked.push({ entry, post, index });
        }
    }
    const serves = picked.map(p => ({
        serveId: randomUUID(),
        postId: p.post.id,
        version: p.post.version,
        servedAt: ctx.now,
    }));
    await store.recordServes(s.id, {
        viewerId: viewer.id,
        expected: { refresh: s.refresh, cursor: s.cursor, rev: s.rev },
        cursor,
        serves,
    });
    s.cursor = cursor;
    const page = picked.map((p, i) => ({
        serveId: serves[i].serveId,
        post: p.post,
        stale: p.post.version !== p.entry.version,
        relaxed: s.relaxedFrom !== null && p.index >= s.relaxedFrom,
    }));
    const stale = page.filter(x => x.stale).map(x => x.post.id);
    if (stale.length) {
        // The page is already recorded as served, so nothing below may fail it. The hook is an
        // observer. A failed or conflicting rebuild leaves the old order, and the next version
        // mismatch retries it.
        runHook(deps, "onStale", () => deps.onStale?.(stale));
        await rebuildTail(deps, s, viewer, ctx, policy).catch(err => report(deps, "rebuildTail", err));
    }
    return page;
}
// Edit-event entry point: recalculates the unserved ranking if any of `postIds` is still in it.
// Returns true if the order was rewritten.
export async function invalidateRankings(deps, s, viewer, ctx, postIds) {
    assertOwner(s, viewer);
    const changed = new Set(postIds);
    if (!s.order.slice(s.cursor).some(e => changed.has(e.id)))
        return false;
    return rebuildTail(deps, s, viewer, ctx);
}
// Recalculates the unserved part of the ranking from authoritative records. Delivery calls it
// whenever it finds a version mismatch: that proves the cached ranking is out of date, and it
// cannot tell which other entries are. The served prefix is kept, tiers keep their order via
// `rank`, and the diversity window continues across the seam. Posts that are no longer eligible
// leave the order. The local share applies to the fresh tier only, so a recycled or reshown
// local post never jumps ahead of a fresh one. Returns true if the order was rewritten.
export async function rebuildTail(deps, s, viewer, ctx, policy) {
    assertOwner(s, viewer);
    const rest = s.order.slice(s.cursor);
    if (!rest.length)
        return false;
    const { authority, store, cfg } = deps;
    const pol = policy ?? (await authority.viewer(viewer.id));
    const allow = deps.gate({ ...pol, id: viewer.id }, ctx);
    const auth = await authority.posts(rest.map(e => e.id));
    const records = admissible(rest.flatMap(e => auth.get(e.id) ?? []), allow);
    const rank = new Map(rest.map(e => [e.id, e.rank]));
    const v = { ...viewer, exposures: await store.exposures(viewer.id) };
    const rng = mulberry32(s.seed * 1000 + s.refresh + (s.rev + 1) * 7919);
    const sampled = orderSample(records, v, ctx, cfg, rng, p => rank.get(p.id));
    // Keep tier order: a rank-1 recycled item must never be pulled ahead of a rank-0 fresh one.
    const grouped = new Map();
    for (const p of sampled) {
        const r = rank.get(p.id);
        const list = grouped.get(r);
        if (list)
            list.push(p);
        else
            grouped.set(r, [p]);
    }
    const tiers = [...grouped.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, list]) => list);
    const served = s.order.slice(0, s.cursor);
    const redo = diversifyTiers(tiers, cfg, served.map(e => e.authorId), grouped.has(0) ? { regionId: v.regionId, share: cfg.localShare[ctx.surface] } : undefined);
    const next = {
        ...s,
        rev: s.rev + 1,
        order: served.concat(redo.order.map(p => toEntry(p, rank.get(p.id)))),
        // The served prefix is never served again, so its old marker no longer means anything.
        // Keeping it would flag every post in the rebuilt tail as relaxed.
        relaxedFrom: redo.relaxedFrom === null ? null : s.cursor + redo.relaxedFrom,
    };
    await store.replace(next, { refresh: s.refresh, cursor: s.cursor, rev: s.rev });
    s.rev = next.rev;
    s.order = next.order;
    s.relaxedFrom = next.relaxedFrom;
    return true;
}
// ---------- view claims ----------
const qualifies = (e, cfg) => e.visibleMs >= cfg.view.minVisibleMs && e.visibleFraction >= cfg.view.minVisibleFraction;
// Client events are claims, never proof of viewing. A receipt only proves the server served
// the post to this viewer in this session. Claims are bounded for physical plausibility, count
// once, and drive viewer-scoped state only (fatigue, replay exclusion). They never touch
// post-level quality counters: the claim log feeds the fraud-qualification pipeline.
//
// Viewing time is one resource per session, not per call. A claim is charged against the time
// the batch could have watched since its earliest serve and against the time the whole session
// could have watched since it opened, less what earlier calls already charged. The store
// compare-and-sets that total, so splitting reports across calls or racing them cannot mint
// more time. A StoreConflict means another call got there first: reload and retry.
//
// A receipt is consumed even when its claim is judged implausible: a retry cannot rescue it.
// Nothing is mutated unless the store commit succeeds, so a failed call can be retried.
const VIEW_COMMIT_ATTEMPTS = 3;
export async function recordViews(deps, s, viewer, events, receivedAt) {
    for (let attempt = 0;; attempt++) {
        try {
            return await recordViewsOnce(deps, s, viewer, events, receivedAt);
        }
        catch (err) {
            if (!(err instanceof StoreConflict) || attempt >= VIEW_COMMIT_ATTEMPTS - 1)
                throw err;
            // The winning call changed spent time and/or receipts. Re-read both before retrying.
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt));
        }
    }
}
async function recordViewsOnce(deps, s, viewer, events, receivedAt) {
    const { cfg, store } = deps;
    const rejected = {};
    const reject = (r) => { rejected[r] = (rejected[r] ?? 0) + 1; };
    const all = Array.isArray(events) ? events : [];
    const considered = all.slice(0, cfg.view.maxBatch);
    for (let i = considered.length; i < all.length; i++)
        reject("batch_limit");
    const serveIds = considered.flatMap(e => (typeof e?.serveId === "string" ? [e.serveId] : []));
    const receipts = await store.receipts(s.id, [...new Set(serveIds)]);
    const pending = [];
    const inBatch = new Set();
    for (const e of considered) {
        const serveId = typeof e?.serveId === "string" ? e.serveId : "";
        const r = receipts.get(serveId);
        if (!r) {
            reject("unknown");
            continue;
        }
        if (r.viewerId !== viewer.id || s.viewerId !== viewer.id) {
            reject("wrong_viewer");
            continue;
        }
        if (r.redeemed || inBatch.has(serveId)) {
            reject("duplicate");
            continue;
        }
        if (receivedAt - r.servedAt > cfg.view.receiptTtlMs) {
            reject("expired");
            continue;
        }
        inBatch.add(serveId);
        pending.push({ e, r, serveId });
    }
    if (!pending.length)
        return { accepted: [], rejected };
    pending.sort((a, b) => a.r.servedAt - b.r.servedAt);
    const spent = await store.viewSpent(s.id);
    const persisted = await store.load(s.id);
    if (!persisted || persisted.viewerId !== viewer.id)
        throw new SessionAccessError("session not found");
    const opened = persisted.startedAt;
    const sinceBatch = cfg.view.viewportCapacity * (receivedAt - pending[0].r.servedAt) + cfg.view.slackMs;
    const sinceOpen = cfg.view.viewportCapacity * (receivedAt - opened) + cfg.view.slackMs - spent;
    let budget = Math.max(0, Math.min(sinceBatch, sinceOpen));
    const accept = [];
    const claims = [];
    const postsInBatch = new Set();
    for (const { e, r, serveId } of pending) {
        const elapsed = receivedAt - r.servedAt;
        const sane = Number.isFinite(receivedAt) &&
            elapsed >= 0 &&
            Number.isFinite(e.visibleMs) &&
            e.visibleMs >= 0 &&
            e.visibleMs <= elapsed + cfg.view.slackMs &&
            Number.isFinite(e.visibleFraction) &&
            e.visibleFraction >= 0 &&
            e.visibleFraction <= 1;
        let outcome = "qualified_claim";
        let costMs = 0;
        if (!sane) {
            outcome = "implausible";
        }
        else {
            const cost = e.visibleMs * e.visibleFraction;
            if (cost > budget)
                outcome = "implausible";
            else {
                budget -= cost;
                costMs = cost;
            }
        }
        if (outcome === "qualified_claim" && !qualifies(e, cfg))
            outcome = "below_threshold";
        if (outcome === "qualified_claim" && postsInBatch.has(r.postId))
            outcome = "duplicate";
        if (outcome === "qualified_claim") {
            postsInBatch.add(r.postId);
            accept.push({ serveId, postId: r.postId });
        }
        claims.push({
            serveId,
            viewerId: viewer.id,
            postId: r.postId,
            version: r.version,
            servedAt: r.servedAt,
            receivedAt,
            visibleMs: Number.isFinite(e.visibleMs) ? e.visibleMs : -1,
            visibleFraction: Number.isFinite(e.visibleFraction) ? e.visibleFraction : -1,
            costMs,
            outcome,
        });
    }
    const result = await store.commitViews({
        sessionId: s.id,
        viewerId: viewer.id,
        consume: pending.map(p => p.serveId),
        accept,
        claims,
        receivedAt,
        halfLifeH: cfg.exposureHalfLifeH,
        ttlMs: cfg.view.receiptTtlMs,
        expectedSpentMs: spent,
    });
    const won = new Set(result.redeemed);
    const duplicates = new Set(result.duplicates);
    const accepted = [];
    for (const c of claims) {
        if (!won.has(c.serveId))
            reject("duplicate");
        else if (c.outcome !== "qualified_claim")
            reject(c.outcome);
        else if (duplicates.has(c.serveId))
            reject("duplicate"); // post already claimed this session
        else
            accepted.push(c.postId);
    }
    // Object.assign on attacker-chosen post IDs such as "__proto__" can mutate a
    // plain object's prototype. Preserve all IDs as own data properties instead.
    for (const [id, exposure] of Object.entries(result.exposures)) {
        Object.defineProperty(viewer.exposures, id, {
            value: exposure, enumerable: true, configurable: true, writable: true,
        });
    }
    return { accepted, rejected };
}
export async function refreshSession(deps, s, viewer, ctx, events) {
    const { accepted, rejected } = await recordViews(deps, s, viewer, events, ctx.now);
    const session = await advanceSession(deps, s, viewer, ctx);
    return { session, accepted, rejected };
}
// ---------- in-memory index, authority and store (swap for real services in prod) ----------
export function buildIndex(posts, cfg, now) {
    // IMPORTANT: filter BEFORE applying per-bucket retrieval limits. Otherwise thousands
    // of Square-only / removed rows can crowd out the few eligible local conversations.
    // Production Index adapters must apply equivalent indexable predicates in their DB queries.
    const live = posts.filter(p => validRankablePost(p) && validPostPolicy(p) &&
        p.moderation === "approved" && p.feedEligible &&
        p.createdAt <= now + cfg.futureSkewMs &&
        (p.expiresAt === null || p.expiresAt > now));
    // Direct ID lookup is not discovery. Ineligible/historical IDs are needed for
    // old receipts and re-show consideration, where the viewer gate runs later.
    // Never feed the lookup cache directly into a client response.
    const lookup = new Map(posts.filter(p => p && typeof p.id === "string").map(p => [p.id, p]));
    const base = new Map(live.map(p => [
        p.id,
        smoothedQuality(p, cfg) * freshness(hours(now - p.createdAt), cfg.freshnessTauH),
    ]));
    const byBase = (a, b) => base.get(b.id) - base.get(a.id) || byId(a, b);
    const byNewest = (a, b) => b.createdAt - a.createdAt || byId(a, b);
    const byTopic = new Map();
    const byRegion = new Map();
    for (const p of live) {
        for (const t of new Set(p.topics)) {
            if (!byTopic.has(t))
                byTopic.set(t, []);
            byTopic.get(t).push(p);
        }
        if (!byRegion.has(p.regionId))
            byRegion.set(p.regionId, []);
        byRegion.get(p.regionId).push(p);
    }
    for (const list of byTopic.values())
        list.sort(byBase);
    for (const list of byRegion.values())
        list.sort(byBase);
    // Round-robin across the other regions so one large region cannot fill every slot.
    const regionLists = [...byRegion.entries()]
        .map(([region, list]) => ({ region, list }))
        .sort((a, b) => base.get(b.list[0].id) - base.get(a.list[0].id) || (a.region < b.region ? -1 : 1));
    const trending = [...live].sort(byBase);
    const newest = [...live].sort(byNewest);
    const unproven = live.filter(p => p.impressions < cfg.unprovenMaxImpressions).sort(byNewest);
    const select = (list, limit, scope) => {
        if (!scope)
            return list.slice(0, limit);
        const allow = scope.gate(scope.viewer, scope.ctx);
        return list.filter(p => allow(p) === "ok").slice(0, limit);
    };
    return {
        topic: async (t, n, scope) => select(byTopic.get(t) ?? [], n, scope),
        region: async (r, n, scope) => select(byRegion.get(r) ?? [], n, scope),
        crossRegion: async (exclude, n, scope) => {
            const lists = regionLists.filter(x => x.region !== exclude)
                .map(x => select(x.list, n, scope));
            const out = [];
            for (let i = 0; out.length < n && lists.some(l => i < l.length); i++) {
                for (const l of lists)
                    if (i < l.length && out.length < n)
                        out.push(l[i]);
            }
            return out;
        },
        trending: async (n, scope) => select(trending, n, scope),
        newest: async (n, scope) => select(newest, n, scope),
        unproven: async (n, scope) => select(unproven, n, scope),
        byIds: async (ids) => ids.flatMap(id => lookup.get(id) ?? []),
    };
}
export function buildAuthority(records, viewerPolicies) {
    return {
        posts: async (ids) => new Map(ids.flatMap(id => {
            const p = records.get(id);
            return p ? [[id, structuredClone(p)]] : [];
        })),
        viewer: async (id) => {
            const v = viewerPolicies.get(id);
            if (!v)
                throw new Error(`no authoritative policy for viewer ${id}`);
            return structuredClone(v);
        },
    };
}
// Dictionary keys are opaque post IDs / viewer IDs. Null-prototype dictionaries avoid
// special property names like "__proto__" and "constructor" changing lookup semantics.
const dict = (x) => Object.assign(Object.create(null), x ?? {});
// Plain-data reference implementation. All state is JSON, so `dump()` / `new MemoryStore(json)`
// behaves like a restart. `faults` makes the next N writes fail, for tests.
export class MemoryStore {
    faults = 0;
    d;
    constructor(json) {
        this.d = json
            ? JSON.parse(json)
            : { sessions: {}, served: {}, claimed: {}, receipts: {}, exposures: {}, spent: {}, claims: [] };
        this.d.sessions = dict(this.d.sessions);
        this.d.served = dict(this.d.served);
        this.d.claimed = dict(this.d.claimed);
        this.d.receipts = dict(this.d.receipts);
        this.d.exposures = dict(this.d.exposures);
        this.d.spent = dict(this.d.spent);
        for (const k of Object.keys(this.d.served))
            this.d.served[k] = dict(this.d.served[k]);
        for (const k of Object.keys(this.d.receipts))
            this.d.receipts[k] = dict(this.d.receipts[k]);
        for (const k of Object.keys(this.d.exposures))
            this.d.exposures[k] = dict(this.d.exposures[k]);
    }
    dump() { return JSON.stringify(this.d); }
    seedExposures(viewerId, ex) {
        this.d.exposures[viewerId] = dict(structuredClone(ex));
    }
    claimLog() { return structuredClone(this.d.claims); }
    claimOutcomes() {
        const out = {};
        for (const c of this.d.claims)
            out[c.outcome] = (out[c.outcome] ?? 0) + 1;
        return out;
    }
    failIfFaulted() {
        if (this.faults > 0) {
            this.faults--;
            throw new Error("store unavailable");
        }
    }
    async create(s) {
        this.failIfFaulted();
        if (this.d.sessions[s.id])
            throw new StoreConflict(`session ${s.id} already exists`);
        this.d.sessions[s.id] = structuredClone(s);
    }
    async replace(next, expected) {
        this.failIfFaulted();
        const cur = this.d.sessions[next.id];
        if (!cur || cur.viewerId !== next.viewerId)
            throw new SessionAccessError("session not found");
        if (cur.refresh !== expected.refresh || cur.cursor !== expected.cursor || cur.rev !== expected.rev) {
            throw new StoreConflict(`session ${next.id} changed`);
        }
        this.d.sessions[next.id] = structuredClone(next);
    }
    async load(id) {
        const s = this.d.sessions[id];
        return s ? structuredClone(s) : null;
    }
    async history(id) {
        return {
            served: new Map(Object.entries(structuredClone(this.d.served[id] ?? {}))),
            claimed: new Set(this.d.claimed[id] ?? []),
        };
    }
    async exposures(viewerId) {
        return structuredClone(this.d.exposures[viewerId] ?? {});
    }
    async receipts(id, serveIds) {
        const rs = this.d.receipts[id] ?? {};
        return new Map(serveIds.flatMap(sid => (rs[sid] ? [[sid, structuredClone(rs[sid])]] : [])));
    }
    async viewSpent(id) {
        return this.d.spent[id] ?? 0;
    }
    async recordServes(id, a) {
        this.failIfFaulted();
        const s = this.d.sessions[id];
        if (!s || s.viewerId !== a.viewerId)
            throw new SessionAccessError("session not found");
        if (s.cursor !== a.expected.cursor || s.refresh !== a.expected.refresh || s.rev !== a.expected.rev) {
            throw new StoreConflict(`session ${id} changed`);
        }
        const permitted = new Set(s.order.slice(s.cursor, a.cursor).map(x => x.id));
        const selected = new Set();
        const receiptIds = new Set();
        const existing = this.d.receipts[id] ?? {};
        if (!Number.isSafeInteger(a.cursor) || a.cursor < s.cursor || a.cursor > s.order.length) {
            throw new RangeError("invalid session serve cursor");
        }
        for (const x of a.serves) {
            if (!permitted.has(x.postId) || selected.has(x.postId) ||
                !x.serveId || receiptIds.has(x.serveId) || existing[x.serveId] !== undefined ||
                !Number.isFinite(x.servedAt) || !Number.isSafeInteger(x.version) || x.version < 0) {
                throw new RangeError("invalid session serve batch");
            }
            selected.add(x.postId);
            receiptIds.add(x.serveId);
        }
        s.cursor = a.cursor;
        const rs = (this.d.receipts[id] ??= dict());
        const sv = (this.d.served[id] ??= dict());
        for (const x of a.serves) {
            rs[x.serveId] = {
                viewerId: s.viewerId,
                postId: x.postId,
                version: x.version,
                servedAt: x.servedAt,
                redeemed: false,
            };
            sv[x.postId] = { count: (sv[x.postId]?.count ?? 0) + 1, lastRefresh: a.expected.refresh };
        }
    }
    async commitViews(a) {
        this.failIfFaulted();
        const owner = this.d.sessions[a.sessionId];
        if (!owner || owner.viewerId !== a.viewerId)
            throw new SessionAccessError("session not found");
        const spent = this.d.spent[a.sessionId] ?? 0;
        if (spent !== a.expectedSpentMs)
            throw new StoreConflict(`session ${a.sessionId} view budget changed`);
        const rs = (this.d.receipts[a.sessionId] ??= dict());
        // The store validates the caller's associations as well as CAS. An incorrect
        // claim must never be able to raise the exposure of an unrelated post.
        const consumed = new Set(a.consume);
        const valid = (sid, postId, version) => {
            const r = rs[sid];
            return consumed.has(sid) && r && r.viewerId === a.viewerId &&
                r.postId === postId && (version === undefined || r.version === version);
        };
        if (!Number.isFinite(a.receivedAt) || !Number.isFinite(a.ttlMs) || a.ttlMs < 0 ||
            a.accept.some(x => !valid(x.serveId, x.postId)) ||
            a.claims.some(x => !valid(x.serveId, x.postId, x.version) ||
                !Number.isFinite(x.costMs) || x.costMs < 0 || x.viewerId !== a.viewerId ||
                !Number.isFinite(x.receivedAt) || x.receivedAt !== a.receivedAt)) {
            throw new RangeError("invalid view commit associations");
        }
        const won = [...consumed].filter(sid => rs[sid] && !rs[sid].redeemed && rs[sid].viewerId === a.viewerId);
        const wonSet = new Set(won);
        for (const sid of won)
            rs[sid].redeemed = true;
        const ex = (this.d.exposures[a.viewerId] ??= dict());
        const claimed = (this.d.claimed[a.sessionId] ??= []);
        const exposures = dict();
        const duplicates = new Set();
        for (const { serveId, postId } of a.accept) {
            if (!wonSet.has(serveId))
                continue;
            if (claimed.includes(postId)) {
                duplicates.add(serveId);
                continue;
            }
            ex[postId] = bumpExposure(ex[postId], a.receivedAt, a.halfLifeH);
            exposures[postId] = ex[postId];
            claimed.push(postId);
        }
        let charged = 0;
        for (const c of a.claims) {
            if (!wonSet.has(c.serveId))
                continue;
            charged += c.costMs;
            this.d.claims.push({
                ...structuredClone(c),
                outcome: duplicates.has(c.serveId) ? "duplicate" : c.outcome,
            });
        }
        this.d.spent[a.sessionId] = spent + charged;
        for (const [sid, r] of Object.entries(rs)) {
            if (a.receivedAt - r.servedAt > a.ttlMs)
                delete rs[sid];
        }
        return { redeemed: won, duplicates: [...duplicates], exposures: structuredClone(exposures) };
    }
}
export async function simulate(deps, viewer, ctx, opts) {
    const { seed, refreshes, pageSize, scrolls } = opts;
    const v = structuredClone(viewer);
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const served = [];
    const claimedSoFar = new Set();
    const rejectedTotal = {};
    let afterClaimed = 0;
    let acceptedTotal = 0;
    let relaxedServed = 0;
    let crossServed = 0;
    let s = await openSession(deps, v, ctx, { seed });
    for (let r = 0; r < refreshes; r++) {
        const at = ctx.now + r * 60_000;
        const label = `[${s.tier}, pool ${s.order.length}]`;
        const page = [];
        for (let i = 0; i <= scrolls; i++) {
            page.push(...(await nextPage(deps, s, v, { ...ctx, now: at }, pageSize)));
        }
        afterClaimed += page.filter(x => claimedSoFar.has(x.post.id)).length;
        const relaxed = page.filter(x => x.relaxed).length;
        relaxedServed += relaxed;
        crossServed += page.filter(x => x.post.regionId !== v.regionId).length;
        served.push(...page.map(x => x.post.id));
        // Each post gets at most a 3s share of the window, so honest dwell stays plausible.
        const windowMs = page.length * 3000;
        const events = page.map(x => ({
            serveId: x.serveId,
            visibleMs: 200 + rng() * 2800,
            visibleFraction: rng() < 0.8 ? 1 : 0.4,
        }));
        const res = await refreshSession(deps, s, v, { ...ctx, now: at + windowMs }, events);
        s = res.session;
        res.accepted.forEach(id => claimedSoFar.add(id));
        acceptedTotal += res.accepted.length;
        for (const [k, n] of Object.entries(res.rejected)) {
            rejectedTotal[k] = (rejectedTotal[k] ?? 0) + n;
        }
        console.log(`refresh ${r + 1} ${label}:`, page.map(x => x.post.id).join(", ") || "(feed exhausted)", `| claimed ${res.accepted.length}/${page.length}`, relaxed ? `| relaxed ${relaxed}` : "");
    }
    const distinct = new Set(served).size;
    console.log("served:", served.length, "| distinct:", distinct, "| claimed:", acceptedTotal, "| re-served unclaimed:", served.length - distinct, "| served after claimed (must be 0):", afterClaimed, "| relaxed:", relaxedServed, "| cross-region:", `${crossServed} (${Math.round((100 * crossServed) / Math.max(1, served.length))}%)`);
    console.log("view events rejected:", rejectedTotal);
    return {
        served: served.length,
        distinct,
        claimed: acceptedTotal,
        afterClaimed,
        relaxed: relaxedServed,
        crossRegion: crossServed,
        rejected: rejectedTotal,
    };
}
// ---------- harness ----------
// Test values only. Not Dlope policy: weights, thresholds and decay rates need approval.
export const EXPERIMENTAL_CONFIG = {
    status: "experimental",
    weights: {
        home: { interest: 0.35, community: 0.15, quality: 0.25, freshness: 0.15, fatigue: 0.10 },
        local: { interest: 0.15, community: 0.40, quality: 0.20, freshness: 0.15, fatigue: 0.10 },
        explore: { interest: 0.20, community: 0.10, quality: 0.35, freshness: 0.20, fatigue: 0.15 },
    },
    temperature: 0.15,
    priorRate: 0.1,
    priorStrength: 20,
    freshnessTauH: 72,
    fatigueK: 2,
    exposureHalfLifeH: 168,
    // A viewed post stays out of fresh pools while its decayed count is at least this. At 0.5 a
    // single view blocks it for one half-life (a week); it can still come back as "recycled"
    // when the fresh pool is thin. Was 3, which needed three recent views to block anything.
    seenBlock: 0.5,
    maxServesPerSession: 2,
    maxPerAuthor: 2,
    diversityWindow: 10,
    minPool: 20,
    minLocalPool: 10,
    widenFactor: 3,
    crossWidenFactor: 4,
    maxTopics: 10,
    maxServeScan: 100,
    maxOrder: 200,
    unprovenMaxImpressions: 50,
    futureSkewMs: 60_000,
    localShare: { home: 0.5, local: 0.8, explore: 0 },
    budget: { topic: 150, region: 300, crossRegion: 150, trending: 200, newest: 100, unproven: 100 },
    view: {
        minVisibleMs: 1000,
        minVisibleFraction: 0.5,
        viewportCapacity: 1,
        receiptTtlMs: 30 * 60_000,
        slackMs: 2000,
        maxBatch: 100,
    },
};
async function main() {
    const { default: dummies } = await import("./dummies.json", { with: { type: "json" } });
    const cfg = EXPERIMENTAL_CONFIG;
    const now = dummies.now;
    const exposureAgeH = Number(process.env.EXPOSURE_AGE_H ?? 0);
    const posts = dummies.posts.map((p) => ({
        id: p.id,
        authorId: p.authorId,
        regionId: p.regionId,
        topics: p.topics,
        createdAt: p.createdAt,
        impressions: p.impressions,
        satisfied: p.satisfied,
        visibility: "public",
        moderation: p.eligible ? "approved" : "removed",
        geo: null,
        expiresAt: null,
        minAge: null,
        feedEligible: true,
        version: 1,
    }));
    const viewer = {
        id: "viewer-1",
        regionId: dummies.viewer.regionId,
        jurisdiction: "XX",
        age: null,
        interests: dummies.viewer.interests,
        hiddenAuthors: dummies.viewer.hiddenAuthors,
        hiddenPosts: [],
        blockedAuthors: [],
        blockedBy: [],
        exposures: Object.fromEntries(Object.entries(dummies.viewer.exposures).map(([id, count]) => [
            id,
            { count, lastViewedAt: now - exposureAgeH * 3_600_000 },
        ])),
    };
    const postRecords = new Map(posts.map(p => [p.id, structuredClone(p)]));
    const viewerPolicies = new Map([
        [
            viewer.id,
            {
                jurisdiction: viewer.jurisdiction,
                age: viewer.age,
                hiddenAuthors: viewer.hiddenAuthors,
                hiddenPosts: viewer.hiddenPosts,
                blockedAuthors: viewer.blockedAuthors,
                blockedBy: viewer.blockedBy,
            },
        ],
    ]);
    const store = new MemoryStore();
    store.seedExposures(viewer.id, viewer.exposures);
    const gate = createPolicyGate(cfg.futureSkewMs);
    const deps = {
        index: buildIndex(posts, cfg, now),
        authority: buildAuthority(postRecords, viewerPolicies),
        store,
        gate,
        cfg,
        onError: (where, err) => console.error(`[${where}]`, err),
    };
    const ctx = { surface: "home", now };
    const allow = gate(viewer, ctx);
    const verdicts = {};
    for (const p of posts)
        verdicts[allow(p)] = (verdicts[allow(p)] ?? 0) + 1;
    console.log("gate:", verdicts);
    console.log("Deterministic:", rankDlopeFeed(posts, viewer, ctx, deps).map(p => p.id));
    const seed = process.env.SEED
        ? Number(process.env.SEED)
        : Math.floor(Math.random() * 2 ** 31);
    console.log("seed:", seed);
    await simulate(deps, viewer, ctx, { seed, refreshes: 26, pageSize: 3, scrolls: 1 });
    console.log("claim log:", store.claimOutcomes());
}
// Runs the harness only when this file is the entry point, so tests can import the module.
const isEntry = (() => {
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
})();
if (isEntry)
    main().catch(console.error);
