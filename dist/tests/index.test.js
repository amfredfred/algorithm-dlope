import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EXPERIMENTAL_CONFIG, MemoryStore, StoreConflict, buildAuthority, buildIndex, createPolicyGate, mulberry32, nextPage, openSession, rebuildTail, recordViews, simulate, withLocalShare, } from "../src/index.js";
// ---------- fixtures ----------
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 16, 12);
const ctx = { surface: "home", now: NOW };
const makeCfg = (over = {}) => ({ ...structuredClone(EXPERIMENTAL_CONFIG), ...over });
let seq = 0;
const mkPost = (over = {}) => {
    const id = over.id ?? `p${++seq}`;
    return {
        id,
        authorId: `a-${id}`,
        regionId: "r1",
        topics: ["t1"],
        createdAt: NOW - H,
        impressions: 100,
        satisfied: 20,
        visibility: "public",
        moderation: "approved",
        geo: null,
        expiresAt: null,
        minAge: null,
        feedEligible: true,
        version: 1,
        ...over,
    };
};
const many = (n, over = {}) => Array.from({ length: n }, () => mkPost(over));
const mkViewer = (over = {}) => ({
    id: "v1",
    regionId: "r1",
    jurisdiction: "XX",
    age: 30,
    interests: ["t1"],
    hiddenAuthors: [],
    hiddenPosts: [],
    blockedAuthors: [],
    blockedBy: [],
    exposures: {},
    ...over,
});
const policyOf = (v) => ({
    jurisdiction: v.jurisdiction,
    age: v.age,
    hiddenAuthors: v.hiddenAuthors,
    hiddenPosts: v.hiddenPosts,
    blockedAuthors: v.blockedAuthors,
    blockedBy: v.blockedBy,
});
function rig(posts, v = mkViewer(), cfg = makeCfg(), wrap) {
    const store = new MemoryStore();
    store.seedExposures(v.id, v.exposures);
    const records = new Map(posts.map(p => [p.id, structuredClone(p)]));
    const errors = [];
    const base = buildIndex(posts, cfg, NOW);
    const deps = {
        index: wrap ? wrap(base) : base,
        authority: buildAuthority(records, new Map([[v.id, policyOf(v)]])),
        store,
        gate: createPolicyGate(cfg.futureSkewMs),
        cfg,
        onError: (where, err) => errors.push([where, err]),
    };
    return { deps, store, records, errors, v, cfg };
}
async function served(r, n) {
    const s = await openSession(r.deps, r.v, ctx, { seed: 3 });
    const page = await nextPage(r.deps, s, r.v, ctx, n);
    return { s, page };
}
const ev = (x, visibleMs, visibleFraction = 1) => ({ serveId: x.serveId, visibleMs, visibleFraction });
// ---------- eligibility ----------
test("gate: future-dated, expired, Square-only and age-restricted posts are denied; unknown fails closed", () => {
    const gate = createPolicyGate(60_000)(mkViewer({ age: 17 }), ctx);
    assert.equal(gate(mkPost()), "ok");
    assert.equal(gate(mkPost({ createdAt: NOW + H })), "scheduled");
    assert.equal(gate(mkPost({ createdAt: NOW + 30_000 })), "ok"); // inside the skew allowance
    assert.equal(gate(mkPost({ createdAt: NOW + 61_000 })), "scheduled");
    assert.equal(gate(mkPost({ expiresAt: NOW })), "expired");
    assert.equal(gate(mkPost({ expiresAt: NOW + 1 })), "ok");
    assert.equal(gate(mkPost({ feedEligible: false })), "not_feed");
    assert.equal(gate(mkPost({ minAge: 18 })), "age");
    assert.equal(gate(mkPost({ minAge: 17 })), "ok");
    const unknown = [
        { createdAt: NaN },
        { feedEligible: undefined },
        { expiresAt: undefined },
        { minAge: undefined },
        { geo: undefined },
    ];
    for (const bad of unknown)
        assert.equal(gate(mkPost(bad)), "incomplete", JSON.stringify(bad));
    const unknownAge = createPolicyGate(60_000)(mkViewer({ age: null }), ctx);
    assert.equal(unknownAge(mkPost({ minAge: 13 })), "age"); // age-restricted + unknown age = denied
    assert.equal(unknownAge(mkPost()), "ok");
    const noAge = createPolicyGate(60_000)(mkViewer({ age: undefined }), ctx);
    assert.equal(noAge(mkPost()), "incomplete"); // viewer policy missing a field denies everything
});
test("delivery re-checks publication, expiry and Square-only on the authoritative record", async () => {
    const r = rig(many(40));
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    const [future, expired, square] = [s.order[0].id, s.order[1].id, s.order[2].id];
    // The index snapshot still says these are fine; the authority has moved on.
    r.records.get(future).createdAt = NOW + H;
    r.records.get(expired).expiresAt = NOW - 1;
    r.records.get(square).feedEligible = false;
    const page = await nextPage(r.deps, s, r.v, ctx, 40);
    const ids = new Set(page.map(x => x.post.id));
    assert.ok(!ids.has(future) && !ids.has(expired) && !ids.has(square));
    assert.equal(page.length, 37);
});
test("Square-only posts that reach the index never enter a session order", async () => {
    const posts = [...many(30), ...many(10, { feedEligible: false })];
    const r = rig(posts);
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    const bad = new Set(posts.filter(p => !p.feedEligible).map(p => p.id));
    assert.equal(s.order.length, 30);
    assert.ok(s.order.every(e => !bad.has(e.id)));
});
// ---------- onStale ----------
test("a throwing onStale hook cannot fail a page that is already recorded as served", async () => {
    const r = rig(many(30));
    r.deps.onStale = () => { throw new Error("boom"); };
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    r.records.get(s.order[0].id).version = 2; // authoritative edit after ranking
    const page = await nextPage(r.deps, s, r.v, ctx, 3);
    assert.equal(page.length, 3);
    assert.ok(page.some(x => x.stale));
    assert.equal((await r.store.load(s.id)).cursor, 3); // the serve was committed
    assert.ok(r.errors.some(([where]) => where === "onStale"));
});
test("an onStale hook that rejects leaves no unhandled rejection and no failed page", async () => {
    const unhandled = [];
    const listener = (e) => unhandled.push(e);
    process.on("unhandledRejection", listener);
    try {
        const r = rig(many(30));
        r.deps.onStale = async () => { throw new Error("late boom"); };
        const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
        r.records.get(s.order[0].id).version = 2;
        const page = await nextPage(r.deps, s, r.v, ctx, 3);
        await new Promise(res => setImmediate(res));
        assert.equal(page.length, 3);
        assert.equal(unhandled.length, 0);
        assert.ok(r.errors.some(([where]) => where === "onStale"));
    }
    finally {
        process.off("unhandledRejection", listener);
    }
});
// ---------- view claims ----------
test("view budget: splitting reports across calls cannot mint viewing time", async () => {
    const r = rig(many(30));
    const { s, page } = await served(r, 3);
    const at = NOW + 10_000; // 10s after the serve: at most ~10s (+2s slack) of viewing can exist
    let accepted = 0;
    const rejected = {};
    for (const x of page) {
        const res = await recordViews(r.deps, s, r.v, [ev(x, 10_000)], at);
        accepted += res.accepted.length;
        for (const [k, n] of Object.entries(res.rejected))
            rejected[k] = (rejected[k] ?? 0) + (n ?? 0);
    }
    assert.equal(accepted, 1);
    assert.deepEqual(rejected, { implausible: 2 });
    const spent = await r.store.viewSpent(s.id);
    assert.equal(spent, 10_000);
    assert.equal(await new MemoryStore(r.store.dump()).viewSpent(s.id), spent); // survives a restart
});
test("view budget: the store compare-and-sets the spent total", async () => {
    const r = rig(many(30));
    const { s, page } = await served(r, 2);
    const claim = (x) => ({
        serveId: x.serveId, viewerId: r.v.id, postId: x.post.id, version: 1, servedAt: NOW,
        receivedAt: NOW + 5000, visibleMs: 4000, visibleFraction: 1, costMs: 4000, outcome: "qualified_claim",
    });
    const args = (x, expectedSpentMs) => ({
        sessionId: s.id, viewerId: r.v.id, consume: [x.serveId],
        accept: [{ serveId: x.serveId, postId: x.post.id }], claims: [claim(x)],
        receivedAt: NOW + 5000, halfLifeH: 168, ttlMs: 1_800_000, expectedSpentMs,
    });
    await r.store.commitViews(args(page[0], 0));
    await assert.rejects(r.store.commitViews(args(page[1], 0)), StoreConflict); // stale read of "spent"
    const retry = await r.store.commitViews(args(page[1], await r.store.viewSpent(s.id)));
    assert.deepEqual(retry.redeemed, [page[1].serveId]);
});
test("view budget: two racing report calls cannot overspend", async () => {
    const r = rig(many(30));
    const { s, page } = await served(r, 2);
    const at = NOW + 10_000;
    const results = await Promise.allSettled(page.map(x => recordViews(r.deps, s, structuredClone(r.v), [ev(x, 10_000)], at)));
    const accepted = results.flatMap(x => (x.status === "fulfilled" ? x.value.accepted : []));
    assert.ok(accepted.length <= 1);
    for (const x of results)
        if (x.status === "rejected")
            assert.ok(x.reason instanceof StoreConflict);
    assert.ok((await r.store.viewSpent(s.id)) <= 12_000);
});
test("a second receipt for an already-claimed post earns no second exposure bump", async () => {
    const r = rig(many(30));
    const { s, page } = await served(r, 3);
    const p = page[0];
    // A second serve of the same post inside the session (e.g. a reshown page), as the store sees it.
    const cur = (await r.store.load(s.id));
    await r.store.recordServes(s.id, {
        viewerId: r.v.id,
        expected: { refresh: cur.refresh, cursor: cur.cursor, rev: cur.rev },
        cursor: cur.cursor,
        serves: [{ serveId: "dup-serve", postId: p.post.id, version: p.post.version, servedAt: NOW }],
    });
    const a = await recordViews(r.deps, s, r.v, [ev(p, 2000)], NOW + 5000);
    const b = await recordViews(r.deps, s, r.v, [{ serveId: "dup-serve", visibleMs: 2000, visibleFraction: 1 }], NOW + 6000);
    assert.deepEqual(a.accepted, [p.post.id]);
    assert.deepEqual(b.accepted, []);
    assert.equal(b.rejected.duplicate, 1);
    assert.equal((await r.store.exposures(r.v.id))[p.post.id].count, 1);
    assert.deepEqual(r.store.claimLog().map(c => c.outcome), ["qualified_claim", "duplicate"]);
});
// ---------- local share ----------
const skewed = () => [
    ...many(50, { regionId: "r1", topics: ["t9"], impressions: 1000, satisfied: 50 }), // weak local
    ...many(50, { regionId: "r2", topics: ["t1"], impressions: 1000, satisfied: 900 }), // strong outsiders
];
async function localInFirstTen(share) {
    const cfg = makeCfg({ localShare: { home: share, local: share, explore: share } });
    const r = rig(skewed(), mkViewer(), cfg);
    const s = await openSession(r.deps, r.v, ctx, { seed: 5 });
    const page = await nextPage(r.deps, s, r.v, ctx, 10);
    return page.filter(x => x.post.regionId === "r1").length;
}
test("local share: scores alone let strong outsiders take every slot; the share puts a floor under local", async () => {
    assert.equal(await localInFirstTen(0), 0); // the behavior the review reproduced
    assert.ok((await localInFirstTen(0.5)) >= 5);
    assert.equal(await localInFirstTen(1), 10);
});
test("local share: every prefix keeps its floor, order within each side is stable, and nothing is dropped", () => {
    const rng = mulberry32(7);
    for (let round = 0; round < 200; round++) {
        const n = 1 + Math.floor(rng() * 60);
        const posts = Array.from({ length: n }, (_, i) => mkPost({ id: `x${round}-${i}`, regionId: rng() < 0.3 ? "r1" : "r2" }));
        const share = Math.floor(rng() * 11) / 10;
        const out = withLocalShare(posts, "r1", share);
        assert.deepEqual([...out].map(p => p.id).sort(), posts.map(p => p.id).sort());
        const totalLocal = posts.filter(p => p.regionId === "r1").length;
        let local = 0;
        out.forEach((p, i) => {
            if (p.regionId === "r1")
                local++;
            assert.ok(local >= Math.min(Math.floor(share * (i + 1) + 1e-9), totalLocal), `round ${round} prefix ${i + 1}`);
        });
        for (const region of ["r1", "r2"]) {
            const before = posts.filter(p => p.regionId === region).map(p => p.id);
            const after = out.filter(p => p.regionId === region).map(p => p.id);
            assert.deepEqual(after, before);
        }
    }
});
test("local share: a rebuilt tail keeps the floor", async () => {
    const cfg = makeCfg({ localShare: { home: 0.5, local: 0.5, explore: 0.5 } });
    const r = rig(skewed(), mkViewer(), cfg);
    const s = await openSession(r.deps, r.v, ctx, { seed: 5 });
    await nextPage(r.deps, s, r.v, ctx, 3);
    assert.equal(await rebuildTail(r.deps, s, r.v, ctx), true);
    const next10 = s.order.slice(s.cursor, s.cursor + 10);
    const local = next10.filter(e => r.records.get(e.id).regionId === "r1").length;
    assert.ok(local >= 5, `local in next 10 = ${local}`);
});
// ---------- replay policy ----------
test("replay: one view withholds a post for about a week, recycles it only when the pool is thin", async () => {
    // Healthy pool: the post viewed an hour ago stays out of the new session.
    const healthy = many(40);
    const seen = healthy[0].id;
    let r = rig(healthy, mkViewer({ exposures: { [seen]: { count: 1, lastViewedAt: NOW - H } } }));
    let s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    assert.equal(s.tier, "fresh");
    assert.ok(!s.order.some(e => e.id === seen));
    // Two weeks of decay later it is eligible again.
    r = rig(healthy, mkViewer({ exposures: { [seen]: { count: 1, lastViewedAt: NOW - 200 * H } } }));
    s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    assert.ok(s.order.some(e => e.id === seen));
    // Thin pool: it comes back, behind everything fresh.
    const thin = many(10);
    const seenThin = thin[0].id;
    r = rig(thin, mkViewer({ exposures: { [seenThin]: { count: 1, lastViewedAt: NOW - H } } }));
    s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    assert.equal(s.tier, "recycled");
    assert.equal(s.order.at(-1).id, seenThin);
    assert.ok(s.order.at(-1).rank > 0);
});
// ---------- retrieval cost ----------
function spyIndex(calls) {
    return (base) => ({
        region: (id, n) => (calls.region.push(n), base.region(id, n)),
        crossRegion: (id, n) => (calls.cross.push(n), base.crossRegion(id, n)),
        trending: n => (calls.trending.push(n), base.trending(n)),
        newest: n => (calls.newest.push(n), base.newest(n)),
        unproven: n => (calls.unproven.push(n), base.unproven(n)),
        topic: (t, n) => (calls.topic.push(n), base.topic(t, n)),
        byIds: ids => base.byIds(ids),
    });
}
const noCalls = () => ({ region: [], cross: [], trending: [], newest: [], unproven: [], topic: [] });
test("widening re-queries only the buckets that came back full", async () => {
    // A small home region: 5 local posts, 300 elsewhere. Local pool is thin, so the pass widens.
    const posts = [
        ...many(5, { regionId: "r1", impressions: 500 }),
        ...many(100, { regionId: "r2", impressions: 500 }),
        ...many(100, { regionId: "r3", impressions: 500 }),
        ...many(100, { regionId: "r4", impressions: 500 }),
    ];
    const calls = noCalls();
    const r = rig(posts, mkViewer(), makeCfg(), spyIndex(calls));
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    assert.equal(s.tier, "widened");
    assert.deepEqual(calls.region, [300]); // returned all 5 it has: never asked again
    assert.deepEqual(calls.unproven, [100]); // returned nothing: never asked again
    assert.deepEqual(calls.cross, [150, 600]);
    assert.deepEqual(calls.trending, [200, 600]);
    assert.deepEqual(calls.topic, [150, 450]);
    assert.deepEqual(calls.newest, [100, 300]);
});
test("a healthy inventory retrieves each bucket exactly once", async () => {
    const posts = [...many(150, { regionId: "r1" }), ...many(300, { regionId: "r2" })];
    const calls = noCalls();
    const r = rig(posts, mkViewer(), makeCfg(), spyIndex(calls));
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    assert.equal(s.tier, "fresh");
    for (const [name, list] of Object.entries(calls))
        assert.equal(list.length, 1, name);
});
test("session order is capped, and a rebuild reads at most that many authoritative records", async () => {
    const posts = Array.from({ length: 600 }, (_, i) => mkPost({ regionId: i % 2 ? "r1" : "r2" }));
    const r = rig(posts, mkViewer(), makeCfg({ maxOrder: 50 }));
    const reads = [];
    const original = r.deps.authority.posts;
    r.deps.authority = { ...r.deps.authority, posts: ids => (reads.push(ids.length), original(ids)) };
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    assert.equal(s.order.length, 50);
    await rebuildTail(r.deps, s, r.v, ctx);
    assert.deepEqual(reads, [50]);
});
// ---------- diversity marker ----------
test("rebuildTail recomputes relaxedFrom for the tail instead of inheriting the served prefix's marker", async () => {
    const r = rig(many(30));
    const s = await openSession(r.deps, r.v, ctx, { seed: 1 });
    await nextPage(r.deps, s, r.v, ctx, 3);
    s.relaxedFrom = 0; // the prefix was relaxed once
    assert.equal(await rebuildTail(r.deps, s, r.v, ctx), true);
    assert.equal(s.relaxedFrom, null);
    const page = await nextPage(r.deps, s, r.v, ctx, 3);
    assert.ok(page.every(x => !x.relaxed));
    // A tail that really needs relaxation still reports it, counted from the seam.
    const same = rig(many(10, { authorId: "solo" }));
    const t = await openSession(same.deps, same.v, ctx, { seed: 1 });
    await nextPage(same.deps, t, same.v, ctx, 3);
    assert.equal(await rebuildTail(same.deps, t, same.v, ctx), true);
    assert.equal(t.relaxedFrom, t.cursor);
});
// ---------- end to end ----------
test("2,000 generated posts: 26 refreshes serve distinct posts, never replay a claimed one, reject no honest view", async () => {
    const rng = mulberry32(99);
    const pick = (a) => a[Math.floor(rng() * a.length)];
    const topics = Array.from({ length: 24 }, (_, i) => `t${i + 1}`);
    const posts = Array.from({ length: 2000 }, (_, i) => {
        const impressions = Math.floor(rng() ** 2 * 4000);
        return mkPost({
            id: `g${i}`,
            authorId: `ga${Math.floor(rng() * 350)}`,
            regionId: rng() < 0.18 ? "r1" : pick(["r2", "r3", "r4", "r5", "r6", "r7", "r8"]),
            topics: [pick(topics), pick(topics)],
            createdAt: NOW - Math.floor(rng() * 30 * 24 * H),
            impressions,
            satisfied: Math.floor(impressions * (0.03 + rng() * 0.5)),
            moderation: rng() < 0.95 ? "approved" : "removed",
        });
    });
    const exposures = Object.fromEntries(posts.filter(() => rng() < 0.04).map(p => [p.id, { count: 1 + Math.floor(rng() * 4), lastViewedAt: NOW }]));
    const r = rig(posts, mkViewer({ interests: topics.slice(0, 6), exposures }));
    const log = mock.method(console, "log", () => { });
    try {
        const stats = await simulate(r.deps, r.v, ctx, { seed: 11, refreshes: 26, pageSize: 3, scrolls: 1 });
        assert.equal(stats.afterClaimed, 0);
        assert.equal(stats.distinct, stats.served);
        assert.equal(stats.rejected.implausible, undefined);
        assert.ok(stats.claimed > 0);
        assert.ok(stats.crossRegion > 0 && stats.crossRegion < stats.served); // both local and global show up
    }
    finally {
        log.mock.restore();
    }
    assert.equal(r.errors.length, 0);
});
