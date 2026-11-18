import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Surface = "home" | "local" | "explore";
export type Moderation = "approved" | "pending" | "restricted" | "removed";
export type Visibility = "public" | "private";
export type GeoRule = { allow?: string[]; deny?: string[] };

export type PostPolicy = {
    id: string;
    authorId: string;
    moderation: Moderation;
    visibility: Visibility;
    geo: GeoRule | null; // null = explicitly unrestricted, undefined = unknown (denied)
    createdAt: number; // server-stamped publication time; later than ctx.now (+ skew) = not yet published
    expiresAt: number | null; // null = never expires, undefined = unknown (denied)
    minAge: number | null; // null = no age restriction, undefined = unknown (denied)
    feedEligible: boolean; // false = Square-only conversation, never enters a feed
};

export type Post = PostPolicy & {
    regionId: string;
    topics: string[];
    impressions: number;
    satisfied: number;
    version: number; // bumps on every edit or content change
};

export type ViewerPolicy = {
    jurisdiction: string;
    age: number | null; // null = unknown: denied for age-restricted posts
    hiddenAuthors: string[];
    hiddenPosts: string[];
    blockedAuthors: string[];
    blockedBy: string[];
};

export type Exposure = { count: number; lastViewedAt: number };

export type Viewer = ViewerPolicy & {
    id: string;
    regionId: string;
    interests: string[];
    exposures: Record<string, Exposure>;
};

export type Context = { surface: Surface; now: number };

export type Verdict =
    | "ok"
    | "incomplete"
    | "moderation"
    | "not_feed"
    | "scheduled"
    | "expired"
    | "blocked"
    | "hidden"
    | "privacy"
    | "age"
    | "geo";

export type Gate = (viewer: ViewerPolicy & { id: string }, ctx: Context) => (post: PostPolicy) => Verdict;

export type Authority = {
    posts(ids: string[]): Promise<Map<string, Post>>; // authoritative full records
    viewer(viewerId: string): Promise<ViewerPolicy>;
};

export type Signals = {
    interest: number;
    community: number;
    quality: number;
    freshness: number;
    fatigue: number;
};

export type Weights = Signals;

export type Config = {
    status: "experimental" | "approved";
    weights: Record<Surface, Weights>;
    temperature: number;
    priorRate: number;
    priorStrength: number;
    freshnessTauH: number;
    fatigueK: number;
    exposureHalfLifeH: number;
    seenBlock: number;
    maxServesPerSession: number;
    maxPerAuthor: number;
    diversityWindow: number;
    minPool: number;
    minLocalPool: number;
    widenFactor: number;
    crossWidenFactor: number;
    maxTopics: number;
    maxServeScan: number;
    maxOrder: number; // cap on a session order: bounds storage and the authority reads of a rebuild
    unprovenMaxImpressions: number;
    futureSkewMs: number; // how far ahead of the server clock createdAt may be and still count as published
    // Floor on the local share of any prefix of the fresh order (0 = score only, 1 = local first).
    // Region is never a boundary: with no local posts left, everything else is served.
    localShare: Record<Surface, number>;
    budget: {
        topic: number;
        region: number;
        crossRegion: number;
        trending: number;
        newest: number;
        unproven: number;
    };
    view: {
        minVisibleMs: number;
        minVisibleFraction: number;
        viewportCapacity: number;
        receiptTtlMs: number;
        slackMs: number;
        maxBatch: number;
    };
};

export type Index = {
    topic(topic: string, limit: number): Promise<Post[]>;
    region(regionId: string, limit: number): Promise<Post[]>;
    crossRegion(excludeRegionId: string, limit: number): Promise<Post[]>;
    trending(limit: number): Promise<Post[]>;
    newest(limit: number): Promise<Post[]>;
    unproven(limit: number): Promise<Post[]>;
    byIds(ids: string[]): Promise<Post[]>;
};

export type Tier = "fresh" | "widened" | "recycled" | "reshown" | "exhausted";

// `version`: content version it was ranked at. `rank`: lower is served first (0 fresh,
// 1+ recycled, 1000+ reshown). `authorId`: kept so a rebuilt tail respects the diversity window.
export type OrderEntry = { id: string; version: number; rank: number; authorId: string };

export type Session = {
    id: string;
    viewerId: string;
    seed: number;
    startedAt: number; // ctx.now at openSession: the clock the session's cumulative view budget runs on
    refresh: number;
    rev: number; // bumps when the unserved part of the order is recalculated
    tier: Tier;
    order: OrderEntry[];
    cursor: number;
    relaxedFrom: number | null; // positions at or after this may break the diversity window
};

export type ServedEntry = { count: number; lastRefresh: number };

export type Receipt = {
    viewerId: string;
    postId: string;
    version: number;
    servedAt: number;
    redeemed: boolean;
};

export type ServeRecord = { serveId: string; postId: string; version: number; servedAt: number };

export type ViewEvent = { serveId: string; visibleMs: number; visibleFraction: number };

export type Reject =
    | "unknown"
    | "wrong_viewer"
    | "duplicate"
    | "expired"
    | "implausible"
    | "below_threshold"
    | "batch_limit";

// A qualified claim is client-reported and unverified. It is never a verified view.
// `costMs` is the viewing time this claim charged to the session's budget (0 if implausible).
export type ViewClaim = {
    serveId: string;
    viewerId: string;
    postId: string;
    version: number;
    servedAt: number;
    receivedAt: number;
    visibleMs: number;
    visibleFraction: number;
    costMs: number;
    outcome: "qualified_claim" | Exclude<Reject, "unknown" | "wrong_viewer" | "expired" | "batch_limit">;
};

export type CommitViews = {
    sessionId: string;
    viewerId: string;
    consume: string[];
    accept: { serveId: string; postId: string }[];
    claims: ViewClaim[];
    receivedAt: number;
    halfLifeH: number;
    ttlMs: number;
    expectedSpentMs: number; // the session's spent view time as read by the caller (compare-and-set)
};

export type Gen = { refresh: number; cursor: number; rev: number };

// Production contract: every method that writes is one atomic transaction.
// `create` is insert-only. `replace` and `recordServes` are compare-and-set on the stored
// (viewerId, refresh, cursor, rev), so concurrent refreshes, rebuilds and page requests cannot
// overwrite or double-serve. `commitViews` is compare-and-set on the session's spent view time
// (`expectedSpentMs`), redeems a receipt only if it is still unredeemed, applies exposure and
// claim writes only for receipts it won, charges only those claims' `costMs` to the session, and
// bumps exposure at most once per post per session: a further qualified claim for a post already
// claimed comes back in `duplicates` and is logged as a duplicate.
export type SessionStore = {
    create(session: Session): Promise<void>;
    replace(next: Session, expected: Gen): Promise<void>;
    load(sessionId: string): Promise<Session | null>;
    history(sessionId: string): Promise<{ served: Map<string, ServedEntry>; claimed: Set<string> }>;
    exposures(viewerId: string): Promise<Record<string, Exposure>>;
    recordServes(
        sessionId: string,
        args: { viewerId: string; expected: Gen; cursor: number; serves: ServeRecord[] }
    ): Promise<void>;
    receipts(sessionId: string, serveIds: string[]): Promise<Map<string, Receipt>>;
    viewSpent(sessionId: string): Promise<number>;
    commitViews(
        args: CommitViews
    ): Promise<{ redeemed: string[]; duplicates: string[]; exposures: Record<string, Exposure> }>;
};

export type Deps = {
    index: Index;
    authority: Authority;
    store: SessionStore;
    gate: Gate;
    cfg: Config;
    // Best-effort observers. Delivery has already committed when they run, so a throw or a
    // rejection from either can never fail or undo a page.
    onStale?: (postIds: string[]) => void | Promise<void>;
    onError?: (where: string, err: unknown) => void;
};

export type Served = { serveId: string; post: Post; stale: boolean; relaxed: boolean };

export class StoreConflict extends Error { }
export class SessionAccessError extends Error { }

const clamp01 = (n: number) =>
    Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

const byId = (a: Post, b: Post) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const hours = (ms: number) => ms / 3_600_000;

const toEntry = (p: Post, rank: number): OrderEntry => ({
    id: p.id,
    version: p.version,
    rank,
    authorId: p.authorId,
});

function assertApproved(cfg: Config) {
    if (process.env.NODE_ENV === "production" && cfg.status !== "approved") {
        throw new Error("ranking config is experimental; refusing to run in production");
    }
}

// Runs an observer hook without letting it affect the caller, then reports what it threw.
function report(deps: Deps, where: string, err: unknown) {
    try {
        deps.onError?.(where, err);
    } catch {
        // the error reporter must not fail delivery either
    }
}

function runHook(deps: Deps, where: string, fn: () => void | Promise<void>) {
    try {
        void Promise.resolve(fn()).catch(err => report(deps, where, err));
    } catch (err) {
        report(deps, where, err);
    }
}

// ---------- signals ----------

function decayedCount(e: Exposure | undefined, now: number, halfLifeH: number): number {
    if (!e) return 0;
    return e.count * 0.5 ** (hours(Math.max(0, now - e.lastViewedAt)) / halfLifeH);
}

const bumpExposure = (prev: Exposure | undefined, at: number, halfLifeH: number): Exposure => ({
    count: decayedCount(prev, at, halfLifeH) + 1,
    lastViewedAt: at,
});

const exposureOf = (viewer: Viewer, postId: string, now: number, cfg: Config) =>
    decayedCount(viewer.exposures[postId], now, cfg.exposureHalfLifeH);

const freshness = (ageH: number, tauH: number) =>
    ageH < 0 ? 0 : Math.exp(-ageH / tauH);

const smoothedQuality = (p: Post, cfg: Config) =>
    clamp01(
        (p.satisfied + cfg.priorRate * cfg.priorStrength) /
        (p.impressions + cfg.priorStrength)
    );

function relevanceScore(s: Signals, w: Weights): number {
    return (
        w.interest * clamp01(s.interest) +
        w.community * clamp01(s.community) +
        w.quality * clamp01(s.quality) +
        w.freshness * clamp01(s.freshness) -
        w.fatigue * clamp01(s.fatigue)
    );
}

function computeSignals(
    post: Post,
    viewer: Viewer,
    interests: Set<string>,
    ctx: Context,
    cfg: Config
): Signals {
    const topics = new Set(post.topics);
    let matches = 0;
    for (const t of topics) if (interests.has(t)) matches++;

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
export function createPolicyGate(futureSkewMs: number): Gate {
    return (viewer, ctx) => {
        const age = viewer.age;
        const complete =
            Array.isArray(viewer.blockedAuthors) &&
            Array.isArray(viewer.blockedBy) &&
            Array.isArray(viewer.hiddenAuthors) &&
            Array.isArray(viewer.hiddenPosts) &&
            (age === null || (typeof age === "number" && Number.isFinite(age) && age >= 0)) &&
            Number.isFinite(ctx.now);
        if (!complete) return () => "incomplete";

        const blocked = new Set(viewer.blockedAuthors);
        const blockedBy = new Set(viewer.blockedBy);
        const hiddenAuthors = new Set(viewer.hiddenAuthors);
        const hiddenPosts = new Set(viewer.hiddenPosts);
        const j = typeof viewer.jurisdiction === "string" ? viewer.jurisdiction : "";

        return post => {
            if (!post || typeof post.id !== "string" || !post.id) return "incomplete";
            if (typeof post.authorId !== "string" || !post.authorId) return "incomplete";
            if (post.moderation == null || post.visibility == null || post.geo === undefined) {
                return "incomplete";
            }
            if (!Number.isFinite(post.createdAt)) return "incomplete";
            if (typeof post.feedEligible !== "boolean") return "incomplete";
            if (post.expiresAt === undefined || (post.expiresAt !== null && !Number.isFinite(post.expiresAt))) {
                return "incomplete";
            }
            if (
                post.minAge === undefined ||
                (post.minAge !== null && (!Number.isFinite(post.minAge) || post.minAge < 0))
            ) {
                return "incomplete";
            }

            const g = post.geo;
            if (g !== null) {
                const bad =
                    typeof g !== "object" ||
                    (g.allow !== undefined && !Array.isArray(g.allow)) ||
                    (g.deny !== undefined && !Array.isArray(g.deny)) ||
                    (g.allow === undefined && g.deny === undefined);
                if (bad) return "incomplete";
            }

            if (post.moderation !== "approved") return "moderation";

            if (!post.feedEligible) return "not_feed";
            if (post.createdAt > ctx.now + futureSkewMs) return "scheduled";
            if (post.expiresAt !== null && post.expiresAt <= ctx.now) return "expired";

            if (blocked.has(post.authorId) || blockedBy.has(post.authorId)) return "blocked";

            if (hiddenAuthors.has(post.authorId) || hiddenPosts.has(post.id)) return "hidden";

            if (post.visibility === "private") {
                if (post.authorId !== viewer.id) return "privacy";
            } else if (post.visibility !== "public") {
                return "privacy";
            }

            if (post.minAge !== null && (age === null || age < post.minAge)) return "age";

            if (g !== null) {
                if (!j) return "geo";
                if (g.deny?.includes(j)) return "geo";
                if (g.allow && !g.allow.includes(j)) return "geo";
            }

            return "ok";
        };
    };
}

function admissible(posts: Post[], allow: (p: PostPolicy) => Verdict): Post[] {
    return posts.filter(p => allow(p) === "ok");
}

// ---------- diversity ----------

type HeapItem = { idx: number; author: string };

class MinHeap {
    private a: HeapItem[] = [];

    get size() { return this.a.length; }

    push(x: HeapItem) {
        const a = this.a;
        a.push(x);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].idx <= a[i].idx) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop(): HeapItem | undefined {
        const a = this.a;
        if (!a.length) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (; ;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].idx < a[m].idx) m = l;
                if (r < a.length && a[r].idx < a[m].idx) m = r;
                if (m === i) break;
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
export function diversify(
    ordered: Post[],
    max: number,
    window: number,
    prior: string[] = []
): { order: Post[]; relaxedFrom: number | null } {
    const cap = Math.max(1, Math.floor(max));
    const W = Math.max(0, window - 1);

    const queues = new Map<string, { idx: number[]; at: number }>();
    ordered.forEach((p, i) => {
        const q = queues.get(p.authorId);
        if (q) q.idx.push(i);
        else queues.set(p.authorId, { idx: [i], at: 0 });
    });
    const head = (a: string) => {
        const q = queues.get(a);
        return q ? q.idx[q.at] : -1;
    };

    const seq = prior.slice(Math.max(0, prior.length - W));
    const counts = new Map<string, number>();
    for (const a of seq) counts.set(a, (counts.get(a) ?? 0) + 1);
    const count = (a: string) => counts.get(a) ?? 0;

    const heap = new MinHeap();
    for (const a of queues.keys()) if (count(a) < cap) heap.push({ idx: head(a), author: a });

    const out: Post[] = [];
    let relaxedFrom: number | null = null;

    while (out.length < ordered.length) {
        let author: string | undefined;
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

        const a = author!;
        const q = queues.get(a)!;
        out.push(ordered[q.idx[q.at]]);
        if (++q.at >= q.idx.length) queues.delete(a);

        seq.push(a);
        const c = count(a) + 1;
        counts.set(a, c);
        if (queues.has(a) && c < cap) heap.push({ idx: head(a), author: a });

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

// Diversifies each tier independently so a later tier can never jump ahead of an earlier one.
// The author window continues across tier seams, and the first relaxed position is reported
// against the concatenated order.
function diversifyTiers(
    tiers: Post[][],
    cfg: Config,
    prior: string[] = []
): { order: Post[]; relaxedFrom: number | null } {
    const out: Post[] = [];
    const authors = prior.slice();
    let relaxedFrom: number | null = null;

    for (const tier of tiers) {
        if (!tier.length) continue;
        const d = diversify(tier, cfg.maxPerAuthor, cfg.diversityWindow, authors);
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
export function withLocalShare(posts: Post[], regionId: string, share: number): Post[] {
    const s = clamp01(share);
    if (s === 0) return posts;

    const local: number[] = [];
    const other: number[] = [];
    posts.forEach((p, i) => (p.regionId === regionId ? local : other).push(i));
    if (!local.length || !other.length) return posts;

    const out: Post[] = [];
    let l = 0;
    let o = 0;
    while (l < local.length || o < other.length) {
        const owed = Math.floor(s * (out.length + 1) + 1e-9) - l; // local posts the prefix is short by
        const takeLocal =
            l >= local.length ? false :
            o >= other.length ? true :
            owed > 0 ? true :
            local[l] < other[o];
        out.push(posts[takeLocal ? local[l++] : other[o++]]);
    }
    return out;
}

// Deterministic reference ranking (tests, debugging)
export function rankDlopeFeed(posts: Post[], viewer: Viewer, ctx: Context, deps: Deps): Post[] {
    const { cfg, gate } = deps;
    const w = cfg.weights[ctx.surface];
    const interests = new Set(viewer.interests);

    const scored = admissible(posts, gate(viewer, ctx)).map(post => ({
        post,
        score: relevanceScore(computeSignals(post, viewer, interests, ctx, cfg), w),
    }));

    scored.sort(
        (a, b) =>
            b.score - a.score ||
            b.post.createdAt - a.post.createdAt ||
            byId(a.post, b.post)
    );

    const shared = withLocalShare(scored.map(s => s.post), viewer.regionId, cfg.localShare[ctx.surface]);
    return diversify(shared, cfg.maxPerAuthor, cfg.diversityWindow).order;
}

// ---------- sampling ----------

export function mulberry32(seed: number) {
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
function orderSample(
    posts: Post[],
    viewer: Viewer,
    ctx: Context,
    cfg: Config,
    rng: () => number,
    rankOf: (p: Post) => number
): Post[] {
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

// ---------- retrieval + sessions ----------

type Bucket = {
    key: string;
    budget: number;
    cross: boolean; // widens by `crossWidenFactor` instead of `widenFactor`
    fetch: (n: number) => Promise<Post[]>;
};

type Fetched = { limit: number; posts: Post[]; full: boolean };

// Cross-region candidates are always retrieved. Their budget grows on its own when local
// content runs thin.
function buckets(index: Index, viewer: Viewer, cfg: Config): Bucket[] {
    const b = cfg.budget;
    const topics = [...new Set(viewer.interests)].slice(0, cfg.maxTopics);
    return [
        { key: "region", budget: b.region, cross: false, fetch: n => index.region(viewer.regionId, n) },
        { key: "cross", budget: b.crossRegion, cross: true, fetch: n => index.crossRegion(viewer.regionId, n) },
        { key: "trending", budget: b.trending, cross: false, fetch: n => index.trending(n) },
        { key: "newest", budget: b.newest, cross: false, fetch: n => index.newest(n) },
        { key: "unproven", budget: b.unproven, cross: false, fetch: n => index.unproven(n) },
        ...topics.map(t => ({
            key: `topic:${t}`,
            budget: b.topic,
            cross: false,
            fetch: (n: number) => index.topic(t, n),
        })),
    ];
}

// Fetches every bucket at the size `scale` asks for. A bucket that came back short already
// returned everything it has, so it is never asked again: only full buckets can yield more.
// Results accumulate in `got`, so a widening pass reuses the first pass instead of replacing it.
async function fetchBuckets(
    plan: Bucket[],
    got: Map<string, Fetched>,
    scale: { base: number; cross: number }
): Promise<void> {
    await Promise.all(
        plan.map(async b => {
            const prev = got.get(b.key);
            if (prev && !prev.full) return;
            const limit = Math.ceil(b.budget * (b.cross ? scale.cross : scale.base));
            if (prev && limit <= prev.limit) return;
            const posts = await b.fetch(limit);
            got.set(b.key, { limit, posts, full: posts.length >= limit });
        })
    );
}

function candidates(got: Map<string, Fetched>): Post[] {
    const unique = new Map<string, Post>();
    for (const f of got.values()) for (const p of f.posts) unique.set(p.id, p);
    return [...unique.values()];
}

function assertOwner(s: Session, viewer: Viewer) {
    if (s.viewerId !== viewer.id) throw new SessionAccessError("session not found");
}

// Same error for "missing" and "someone else's", so ids cannot be probed.
export async function loadSession(deps: Deps, sessionId: string, viewer: Viewer): Promise<Session> {
    const s = await deps.store.load(sessionId);
    if (!s || s.viewerId !== viewer.id) throw new SessionAccessError("session not found");
    return s;
}

// Ranks candidates for one refresh. Reads only; nothing is persisted here. The store is the
// source of truth for exposures, so whatever `viewer.exposures` held on entry is replaced.
export async function buildRanking(
    deps: Deps,
    viewer: Viewer,
    ctx: Context,
    id: string,
    seed: number,
    refresh: number
): Promise<Pick<Session, "tier" | "order" | "relaxedFrom">> {
    const { index, gate, cfg, store } = deps;
    assertApproved(cfg);

    viewer.exposures = await store.exposures(viewer.id);
    const { served, claimed } = await store.history(id);

    // Index snapshots are only a pre-filter; nextPage re-checks against the authority.
    const allow = gate(viewer, ctx);
    const exposure = (p: Post) => exposureOf(viewer, p.id, ctx.now, cfg);
    const blocked = (p: Post) => exposure(p) >= cfg.seenBlock;
    const attempts: [Tier, { base: number; cross: number }][] = [
        ["fresh", { base: 1, cross: 1 }],
        ["widened", { base: cfg.widenFactor, cross: cfg.crossWidenFactor }],
    ];

    const plan = buckets(index, viewer, cfg);
    const got = new Map<string, Fetched>();
    let tier: Tier = "fresh";
    let pool: Post[] = [];

    for (const [t, scale] of attempts) {
        // Every bucket already returned all it has: widening cannot add a post.
        if (got.size && ![...got.values()].some(f => f.full)) break;
        await fetchBuckets(plan, got, scale);
        pool = admissible(candidates(got), allow).filter(p => !served.has(p.id) && !blocked(p));
        tier = t;
        const local = pool.filter(p => p.regionId === viewer.regionId).length;
        if (pool.length >= cfg.minPool && local >= cfg.minLocalPool) break;
    }

    const rank = new Map<string, number>(pool.map(p => [p.id, 0]));
    const rng = mulberry32(seed * 1000 + refresh);
    const fresh = withLocalShare(
        orderSample(pool, viewer, ctx, cfg, rng, () => 0),
        viewer.regionId,
        cfg.localShare[ctx.surface]
    );
    const tiers: Post[][] = [fresh];
    let size = fresh.length;

    // Viewer history above the block threshold, not yet served this session.
    if (size < cfg.minPool) {
        const ids = Object.keys(viewer.exposures).filter(
            pid => !served.has(pid) && exposureOf(viewer, pid, ctx.now, cfg) >= cfg.seenBlock
        );
        const history = admissible(await index.byIds(ids), allow);
        if (history.length) {
            for (const p of history) rank.set(p.id, 1 + Math.floor(exposure(p)));
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
            for (const p of again) rank.set(p.id, 1000 + served.get(p.id)!.lastRefresh);
            const sampled = orderSample(again, viewer, ctx, cfg, rng, p => served.get(p.id)!.lastRefresh);
            tiers.push(sampled);
            tier = "reshown";
        }
    }

    const diversified = diversifyTiers(tiers, cfg);
    const order = diversified.order.slice(0, cfg.maxOrder);
    const relaxedFrom =
        diversified.relaxedFrom !== null && diversified.relaxedFrom < order.length
            ? diversified.relaxedFrom
            : null;
    if (!order.length) tier = "exhausted";

    return { tier, order: order.map(p => toEntry(p, rank.get(p.id)!)), relaxedFrom };
}

// Starts a new session. Always a fresh id, inserted only if absent: it can never overwrite.
export async function openSession(
    deps: Deps,
    viewer: Viewer,
    ctx: Context,
    opts: { seed: number }
): Promise<Session> {
    const id = randomUUID();
    const built = await buildRanking(deps, viewer, ctx, id, opts.seed, 0);
    const session: Session = {
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
export async function advanceSession(
    deps: Deps,
    from: Session,
    viewer: Viewer,
    ctx: Context
): Promise<Session> {
    assertOwner(from, viewer);
    const built = await buildRanking(deps, viewer, ctx, from.id, from.seed, from.refresh + 1);
    const next: Session = { ...from, refresh: from.refresh + 1, rev: 0, cursor: 0, ...built };
    await deps.store.replace(next, { refresh: from.refresh, cursor: from.cursor, rev: from.rev });
    return next;
}

// Serves authoritative records only. Cached entries supply order, never content.
// Throws, serving nothing, if authoritative state or the store is unavailable or conflicts.
export async function nextPage(
    deps: Deps,
    s: Session,
    viewer: Viewer,
    ctx: Context,
    pageSize: number
): Promise<Served[]> {
    assertOwner(s, viewer);
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
        throw new RangeError("pageSize must be a positive integer");
    }
    const { authority, store, cfg } = deps;
    const policy = await authority.viewer(viewer.id);
    const allow = deps.gate({ ...policy, id: viewer.id }, ctx);

    const picked: { entry: OrderEntry; post: Post; index: number }[] = [];
    let cursor = s.cursor;
    let scanned = 0;

    while (picked.length < pageSize && cursor < s.order.length && scanned < cfg.maxServeScan) {
        const batch = s.order.slice(cursor, cursor + pageSize * 2);
        const auth = await authority.posts(batch.map(e => e.id));

        for (const entry of batch) {
            if (picked.length === pageSize || scanned >= cfg.maxServeScan) break;
            const index = cursor++;
            scanned++;

            const post = auth.get(entry.id);
            if (!post || allow(post) !== "ok") continue;
            picked.push({ entry, post, index });
        }
    }

    const serves: ServeRecord[] = picked.map(p => ({
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

    const page: Served[] = picked.map((p, i) => ({
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
export async function invalidateRankings(
    deps: Deps,
    s: Session,
    viewer: Viewer,
    ctx: Context,
    postIds: string[]
): Promise<boolean> {
    assertOwner(s, viewer);
    const changed = new Set(postIds);
    if (!s.order.slice(s.cursor).some(e => changed.has(e.id))) return false;
    return rebuildTail(deps, s, viewer, ctx);
}

// Recalculates the unserved part of the ranking from authoritative records. Delivery calls it
// whenever it finds a version mismatch: that proves the cached ranking is out of date, and it
// cannot tell which other entries are. The served prefix is kept, tiers keep their order via
// `rank`, and the diversity window continues across the seam. Posts that are no longer eligible
// leave the order. The local share applies to the fresh tier only, so a recycled or reshown
// local post never jumps ahead of a fresh one. Returns true if the order was rewritten.
export async function rebuildTail(
    deps: Deps,
    s: Session,
    viewer: Viewer,
    ctx: Context,
    policy?: ViewerPolicy
): Promise<boolean> {
    assertOwner(s, viewer);
    const rest = s.order.slice(s.cursor);
    if (!rest.length) return false;

    const { authority, store, cfg } = deps;
    const pol = policy ?? (await authority.viewer(viewer.id));
    const allow = deps.gate({ ...pol, id: viewer.id }, ctx);
    const auth = await authority.posts(rest.map(e => e.id));
    const records = admissible(rest.flatMap(e => auth.get(e.id) ?? []), allow);
    const rank = new Map(rest.map(e => [e.id, e.rank]));

    const v: Viewer = { ...viewer, exposures: await store.exposures(viewer.id) };
    const rng = mulberry32(s.seed * 1000 + s.refresh + (s.rev + 1) * 7919);
    const sampled = orderSample(records, v, ctx, cfg, rng, p => rank.get(p.id)!);

    const share = cfg.localShare[ctx.surface];
    const firstOld = sampled.findIndex(p => rank.get(p.id) !== 0);
    const ordered =
        firstOld === -1
            ? withLocalShare(sampled, v.regionId, share)
            : withLocalShare(sampled.slice(0, firstOld), v.regionId, share).concat(sampled.slice(firstOld));

    // Keep tier order: a rank-1 recycled item must never be pulled ahead of a rank-0 fresh one.
    const grouped = new Map<number, Post[]>();
    for (const p of ordered) {
        const r = rank.get(p.id)!;
        const list = grouped.get(r);
        if (list) list.push(p);
        else grouped.set(r, [p]);
    }
    const tiers = [...grouped.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, list]) => list);

    const served = s.order.slice(0, s.cursor);
    const redo = diversifyTiers(tiers, cfg, served.map(e => e.authorId));

    const next: Session = {
        ...s,
        rev: s.rev + 1,
        order: served.concat(redo.order.map(p => toEntry(p, rank.get(p.id)!))),
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

const qualifies = (e: ViewEvent, cfg: Config) =>
    e.visibleMs >= cfg.view.minVisibleMs && e.visibleFraction >= cfg.view.minVisibleFraction;

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

export async function recordViews(
    deps: Deps,
    s: Session,
    viewer: Viewer,
    events: ViewEvent[],
    receivedAt: number
): Promise<{ accepted: string[]; rejected: Partial<Record<Reject, number>> }> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await recordViewsOnce(deps, s, viewer, events, receivedAt);
        } catch (err) {
            if (!(err instanceof StoreConflict) || attempt >= VIEW_COMMIT_ATTEMPTS - 1) throw err;
            // The winning call changed spent time and/or receipts. Re-read both before retrying.
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt));
        }
    }
}

async function recordViewsOnce(
    deps: Deps,
    s: Session,
    viewer: Viewer,
    events: ViewEvent[],
    receivedAt: number
): Promise<{ accepted: string[]; rejected: Partial<Record<Reject, number>> }> {
    const { cfg, store } = deps;
    const rejected: Partial<Record<Reject, number>> = {};
    const reject = (r: Reject) => { rejected[r] = (rejected[r] ?? 0) + 1; };

    const all = Array.isArray(events) ? events : [];
    const considered = all.slice(0, cfg.view.maxBatch);
    for (let i = considered.length; i < all.length; i++) reject("batch_limit");

    const serveIds = considered.flatMap(e => (typeof e?.serveId === "string" ? [e.serveId] : []));
    const receipts = await store.receipts(s.id, [...new Set(serveIds)]);

    const pending: { e: ViewEvent; r: Receipt; serveId: string }[] = [];
    const inBatch = new Set<string>();

    for (const e of considered) {
        const serveId = typeof e?.serveId === "string" ? e.serveId : "";
        const r = receipts.get(serveId);
        if (!r) { reject("unknown"); continue; }
        if (r.viewerId !== viewer.id || s.viewerId !== viewer.id) { reject("wrong_viewer"); continue; }
        if (r.redeemed || inBatch.has(serveId)) { reject("duplicate"); continue; }
        if (receivedAt - r.servedAt > cfg.view.receiptTtlMs) { reject("expired"); continue; }
        inBatch.add(serveId);
        pending.push({ e, r, serveId });
    }

    if (!pending.length) return { accepted: [], rejected };

    pending.sort((a, b) => a.r.servedAt - b.r.servedAt);

    const spent = await store.viewSpent(s.id);
    const opened = Number.isFinite(s.startedAt) ? s.startedAt : pending[0].r.servedAt;
    const sinceBatch = cfg.view.viewportCapacity * (receivedAt - pending[0].r.servedAt) + cfg.view.slackMs;
    const sinceOpen = cfg.view.viewportCapacity * (receivedAt - opened) + cfg.view.slackMs - spent;
    let budget = Math.max(0, Math.min(sinceBatch, sinceOpen));

    const accept: { serveId: string; postId: string }[] = [];
    const claims: ViewClaim[] = [];
    const postsInBatch = new Set<string>();

    for (const { e, r, serveId } of pending) {
        const elapsed = receivedAt - r.servedAt;
        const sane =
            Number.isFinite(receivedAt) &&
            elapsed >= 0 &&
            Number.isFinite(e.visibleMs) &&
            e.visibleMs >= 0 &&
            e.visibleMs <= elapsed + cfg.view.slackMs &&
            Number.isFinite(e.visibleFraction) &&
            e.visibleFraction >= 0 &&
            e.visibleFraction <= 1;

        let outcome: ViewClaim["outcome"] = "qualified_claim";
        let costMs = 0;
        if (!sane) {
            outcome = "implausible";
        } else {
            const cost = e.visibleMs * e.visibleFraction;
            if (cost > budget) outcome = "implausible";
            else {
                budget -= cost;
                costMs = cost;
            }
        }
        if (outcome === "qualified_claim" && !qualifies(e, cfg)) outcome = "below_threshold";
        if (outcome === "qualified_claim" && postsInBatch.has(r.postId)) outcome = "duplicate";
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
    const accepted: string[] = [];
    for (const c of claims) {
        if (!won.has(c.serveId)) reject("duplicate");
        else if (c.outcome !== "qualified_claim") reject(c.outcome);
        else if (duplicates.has(c.serveId)) reject("duplicate"); // post already claimed this session
        else accepted.push(c.postId);
    }

    Object.assign(viewer.exposures, result.exposures);
    return { accepted, rejected };
}

export async function refreshSession(
    deps: Deps,
    s: Session,
    viewer: Viewer,
    ctx: Context,
    events: ViewEvent[]
): Promise<{ session: Session; accepted: string[]; rejected: Partial<Record<Reject, number>> }> {
    const { accepted, rejected } = await recordViews(deps, s, viewer, events, ctx.now);
    const session = await advanceSession(deps, s, viewer, ctx);
    return { session, accepted, rejected };
}

// ---------- in-memory index, authority and store (swap for real services in prod) ----------

export function buildIndex(posts: Post[], cfg: Config, now: number): Index {
    const live = posts.filter(p => Number.isFinite(p.createdAt));
    const lookup = new Map(live.map(p => [p.id, p]));

    const base = new Map<string, number>(
        live.map(p => [
            p.id,
            smoothedQuality(p, cfg) * freshness(hours(now - p.createdAt), cfg.freshnessTauH),
        ])
    );
    const byBase = (a: Post, b: Post) => base.get(b.id)! - base.get(a.id)! || byId(a, b);
    const byNewest = (a: Post, b: Post) => b.createdAt - a.createdAt || byId(a, b);

    const byTopic = new Map<string, Post[]>();
    const byRegion = new Map<string, Post[]>();
    for (const p of live) {
        for (const t of new Set(p.topics)) {
            if (!byTopic.has(t)) byTopic.set(t, []);
            byTopic.get(t)!.push(p);
        }
        if (!byRegion.has(p.regionId)) byRegion.set(p.regionId, []);
        byRegion.get(p.regionId)!.push(p);
    }
    for (const list of byTopic.values()) list.sort(byBase);
    for (const list of byRegion.values()) list.sort(byBase);

    // Round-robin across the other regions so one large region cannot fill every slot.
    const regionLists = [...byRegion.entries()]
        .map(([region, list]) => ({ region, list }))
        .sort((a, b) => base.get(b.list[0].id)! - base.get(a.list[0].id)! || (a.region < b.region ? -1 : 1));

    const trending = [...live].sort(byBase);
    const newest = [...live].sort(byNewest);
    const unproven = live.filter(p => p.impressions < cfg.unprovenMaxImpressions).sort(byNewest);

    return {
        topic: async (t, n) => (byTopic.get(t) ?? []).slice(0, n),
        region: async (r, n) => (byRegion.get(r) ?? []).slice(0, n),
        crossRegion: async (exclude, n) => {
            const lists = regionLists.filter(x => x.region !== exclude).map(x => x.list);
            const out: Post[] = [];
            for (let i = 0; out.length < n && lists.some(l => i < l.length); i++) {
                for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
            }
            return out;
        },
        trending: async n => trending.slice(0, n),
        newest: async n => newest.slice(0, n),
        unproven: async n => unproven.slice(0, n),
        byIds: async ids => ids.flatMap(id => lookup.get(id) ?? []),
    };
}

export function buildAuthority(
    records: Map<string, Post>,
    viewerPolicies: Map<string, ViewerPolicy>
): Authority {
    return {
        posts: async ids =>
            new Map(ids.flatMap(id => {
                const p = records.get(id);
                return p ? [[id, structuredClone(p)] as const] : [];
            })),
        viewer: async id => {
            const v = viewerPolicies.get(id);
            if (!v) throw new Error(`no authoritative policy for viewer ${id}`);
            return structuredClone(v);
        },
    };
}

type StoreData = {
    sessions: Record<string, Session>;
    served: Record<string, Record<string, ServedEntry>>;
    claimed: Record<string, string[]>;
    receipts: Record<string, Record<string, Receipt>>;
    exposures: Record<string, Record<string, Exposure>>;
    spent: Record<string, number>;
    claims: ViewClaim[];
};

// Plain-data reference implementation. All state is JSON, so `dump()` / `new MemoryStore(json)`
// behaves like a restart. `faults` makes the next N writes fail, for tests.
export class MemoryStore implements SessionStore {
    faults = 0;
    private d: StoreData;

    constructor(json?: string) {
        this.d = json
            ? JSON.parse(json)
            : { sessions: {}, served: {}, claimed: {}, receipts: {}, exposures: {}, spent: {}, claims: [] };
        this.d.spent ??= {};
    }

    dump() { return JSON.stringify(this.d); }

    seedExposures(viewerId: string, ex: Record<string, Exposure>) {
        this.d.exposures[viewerId] = structuredClone(ex);
    }

    claimLog() { return structuredClone(this.d.claims); }

    claimOutcomes() {
        const out: Record<string, number> = {};
        for (const c of this.d.claims) out[c.outcome] = (out[c.outcome] ?? 0) + 1;
        return out;
    }

    private failIfFaulted() {
        if (this.faults > 0) { this.faults--; throw new Error("store unavailable"); }
    }

    async create(s: Session) {
        this.failIfFaulted();
        if (this.d.sessions[s.id]) throw new StoreConflict(`session ${s.id} already exists`);
        this.d.sessions[s.id] = structuredClone(s);
    }

    async replace(next: Session, expected: Gen) {
        this.failIfFaulted();
        const cur = this.d.sessions[next.id];
        if (!cur || cur.viewerId !== next.viewerId) throw new SessionAccessError("session not found");
        if (cur.refresh !== expected.refresh || cur.cursor !== expected.cursor || cur.rev !== expected.rev) {
            throw new StoreConflict(`session ${next.id} changed`);
        }
        this.d.sessions[next.id] = structuredClone(next);
    }

    async load(id: string) {
        const s = this.d.sessions[id];
        return s ? structuredClone(s) : null;
    }

    async history(id: string) {
        return {
            served: new Map(Object.entries(structuredClone(this.d.served[id] ?? {}))),
            claimed: new Set(this.d.claimed[id] ?? []),
        };
    }

    async exposures(viewerId: string) {
        return structuredClone(this.d.exposures[viewerId] ?? {});
    }

    async receipts(id: string, serveIds: string[]) {
        const rs = this.d.receipts[id] ?? {};
        return new Map(serveIds.flatMap(sid => (rs[sid] ? [[sid, structuredClone(rs[sid])] as const] : [])));
    }

    async viewSpent(id: string) {
        return this.d.spent[id] ?? 0;
    }

    async recordServes(
        id: string,
        a: { viewerId: string; expected: Gen; cursor: number; serves: ServeRecord[] }
    ) {
        this.failIfFaulted();
        const s = this.d.sessions[id];
        if (!s || s.viewerId !== a.viewerId) throw new SessionAccessError("session not found");
        if (s.cursor !== a.expected.cursor || s.refresh !== a.expected.refresh || s.rev !== a.expected.rev) {
            throw new StoreConflict(`session ${id} changed`);
        }

        s.cursor = a.cursor;
        const rs = (this.d.receipts[id] ??= {});
        const sv = (this.d.served[id] ??= {});
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

    async commitViews(a: CommitViews) {
        this.failIfFaulted();
        const owner = this.d.sessions[a.sessionId];
        if (!owner || owner.viewerId !== a.viewerId) throw new SessionAccessError("session not found");

        const spent = this.d.spent[a.sessionId] ?? 0;
        if (spent !== a.expectedSpentMs) throw new StoreConflict(`session ${a.sessionId} view budget changed`);

        const rs = (this.d.receipts[a.sessionId] ??= {});
        const won = a.consume.filter(
            sid => rs[sid] && !rs[sid].redeemed && rs[sid].viewerId === a.viewerId
        );
        const wonSet = new Set(won);

        for (const sid of won) rs[sid].redeemed = true;

        const ex = (this.d.exposures[a.viewerId] ??= {});
        const claimed = (this.d.claimed[a.sessionId] ??= []);
        const exposures: Record<string, Exposure> = {};
        const duplicates = new Set<string>();
        for (const { serveId, postId } of a.accept) {
            if (!wonSet.has(serveId)) continue;
            if (claimed.includes(postId)) { duplicates.add(serveId); continue; }
            ex[postId] = bumpExposure(ex[postId], a.receivedAt, a.halfLifeH);
            exposures[postId] = ex[postId];
            claimed.push(postId);
        }

        let charged = 0;
        for (const c of a.claims) {
            if (!wonSet.has(c.serveId)) continue;
            charged += c.costMs;
            this.d.claims.push({
                ...structuredClone(c),
                outcome: duplicates.has(c.serveId) ? "duplicate" : c.outcome,
            });
        }
        this.d.spent[a.sessionId] = spent + charged;

        for (const [sid, r] of Object.entries(rs)) {
            if (a.receivedAt - r.servedAt > a.ttlMs) delete rs[sid];
        }

        return { redeemed: won, duplicates: [...duplicates], exposures: structuredClone(exposures) };
    }
}

// ---------- refresh simulation ----------

export type SimStats = {
    served: number;
    distinct: number;
    claimed: number;
    afterClaimed: number;
    relaxed: number;
    crossRegion: number;
    rejected: Partial<Record<Reject, number>>;
};

export async function simulate(
    deps: Deps,
    viewer: Viewer,
    ctx: Context,
    opts: { seed: number; refreshes: number; pageSize: number; scrolls: number }
): Promise<SimStats> {
    const { seed, refreshes, pageSize, scrolls } = opts;
    const v: Viewer = structuredClone(viewer);
    const rng = mulberry32(seed ^ 0x9e3779b9);

    const served: string[] = [];
    const claimedSoFar = new Set<string>();
    const rejectedTotal: Partial<Record<Reject, number>> = {};
    let afterClaimed = 0;
    let acceptedTotal = 0;
    let relaxedServed = 0;
    let crossServed = 0;

    let s = await openSession(deps, v, ctx, { seed });

    for (let r = 0; r < refreshes; r++) {
        const at = ctx.now + r * 60_000;
        const label = `[${s.tier}, pool ${s.order.length}]`;

        const page: Served[] = [];
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
        const events: ViewEvent[] = page.map(x => ({
            serveId: x.serveId,
            visibleMs: 200 + rng() * 2800,
            visibleFraction: rng() < 0.8 ? 1 : 0.4,
        }));

        const res = await refreshSession(deps, s, v, { ...ctx, now: at + windowMs }, events);
        s = res.session;
        res.accepted.forEach(id => claimedSoFar.add(id));
        acceptedTotal += res.accepted.length;
        for (const [k, n] of Object.entries(res.rejected)) {
            rejectedTotal[k as Reject] = (rejectedTotal[k as Reject] ?? 0) + n;
        }

        console.log(
            `refresh ${r + 1} ${label}:`,
            page.map(x => x.post.id).join(", ") || "(feed exhausted)",
            `| claimed ${res.accepted.length}/${page.length}`,
            relaxed ? `| relaxed ${relaxed}` : ""
        );
    }

    const distinct = new Set(served).size;
    console.log(
        "served:", served.length,
        "| distinct:", distinct,
        "| claimed:", acceptedTotal,
        "| re-served unclaimed:", served.length - distinct,
        "| served after claimed (must be 0):", afterClaimed,
        "| relaxed:", relaxedServed,
        "| cross-region:", `${crossServed} (${Math.round((100 * crossServed) / Math.max(1, served.length))}%)`
    );
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
export const EXPERIMENTAL_CONFIG: Config = {
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

// Type-only contract for the optional JSON simulation fixture. No ranking or runtime behavior changes.
type DummyPost = Pick<
    Post,
    "id" | "authorId" | "regionId" | "topics" | "createdAt" | "impressions" | "satisfied"
> & { eligible: boolean };

type DummyDataset = {
    now: number;
    posts: DummyPost[];
    viewer: {
        regionId: string;
        interests: string[];
        hiddenAuthors: string[];
        exposures: Record<string, number>;
    };
};

async function main(): Promise<void> {
    const { default: dummies }: { default: DummyDataset } = await import("./dummies.json", { with: { type: "json" } });

    const cfg = EXPERIMENTAL_CONFIG;
    const now = dummies.now;
    const exposureAgeH = Number(process.env.EXPOSURE_AGE_H ?? 0);

    const posts = dummies.posts.map((p): Post => ({
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

    const viewer: Viewer = {
        id: "viewer-1",
        regionId: dummies.viewer.regionId,
        jurisdiction: "XX",
        age: null,
        interests: dummies.viewer.interests,
        hiddenAuthors: dummies.viewer.hiddenAuthors,
        hiddenPosts: [],
        blockedAuthors: [],
        blockedBy: [],
        exposures: Object.fromEntries(
            Object.entries(dummies.viewer.exposures).map(([id, count]) => [
                id,
                { count, lastViewedAt: now - exposureAgeH * 3_600_000 },
            ])
        ),
    };

    const postRecords = new Map<string, Post>(posts.map(p => [p.id, structuredClone(p)]));
    const viewerPolicies = new Map<string, ViewerPolicy>([
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
    const deps: Deps = {
        index: buildIndex(posts, cfg, now),
        authority: buildAuthority(postRecords, viewerPolicies),
        store,
        gate,
        cfg,
        onError: (where, err) => console.error(`[${where}]`, err),
    };

    const ctx: Context = { surface: "home", now };

    const allow = gate(viewer, ctx);
    const verdicts: Record<string, number> = {};
    for (const p of posts) verdicts[allow(p)] = (verdicts[allow(p)] ?? 0) + 1;
    console.log("gate:", verdicts);

    console.log(
        "Deterministic:",
        rankDlopeFeed(posts, viewer, ctx, deps).map(p => p.id)
    );

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
    } catch {
        return false;
    }
})();

if (isEntry) main().catch(console.error);