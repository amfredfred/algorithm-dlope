import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, StoreConflict, nextPage, openSession, recordViews } from '../src/index.js';
import { CTX, NOW, H, cfg, posts, rig, viewer } from './helpers.js';
const dwell = [-1, 0, 100, 999, 1000, 1001, 1500, 2000, 5000, 10000, 10001, 12000, 15000, NaN, Infinity, -Infinity];
const visible = [-0.1, 0, 0.1, 0.49, 0.5, 0.51, 0.75, 0.99, 1, 1.01, NaN, Infinity, -Infinity];
for (const ms of dwell)
    for (const fraction of visible) {
        test(`view qualification millis=${String(ms)} fraction=${String(fraction)}`, async () => {
            const r = rig(posts(25));
            const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
            const page = await nextPage(r.deps, s, r.viewer, CTX, 1);
            const at = NOW + 10_000;
            const events = [{ serveId: page[0].serveId, visibleMs: ms, visibleFraction: fraction }];
            const got = await recordViews(r.deps, s, r.viewer, events, at);
            const sane = Number.isFinite(ms) && ms >= 0 && ms <= 12000 && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
            const plausible = sane && (ms * fraction) <= 12000;
            const qualified = plausible && ms >= 1000 && fraction >= 0.5;
            const reject = !plausible ? 'implausible' : !qualified ? 'below_threshold' : null;
            assert.equal(got.accepted.length, qualified ? 1 : 0);
            if (reject)
                assert.equal(got.rejected[reject], 1);
            assert.equal((await r.store.viewSpent(s.id)), plausible ? ms * fraction : 0);
        });
    }
for (const offset of [-1, 0, 1, 999, 1000, 2000, 5000, 30 * 60_000, 30 * 60_000 + 1, 30 * 60_000 + 100_000]) {
    test(`receipt TTL boundary delta=${offset}`, async () => {
        const r = rig(posts(25));
        const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
        const page = await nextPage(r.deps, s, r.viewer, CTX, 1);
        const got = await recordViews(r.deps, s, r.viewer, [{ serveId: page[0].serveId, visibleMs: 1000, visibleFraction: 1 }], NOW + offset);
        const expired = offset > r.cfg.view.receiptTtlMs;
        assert.equal(got.rejected.expired ?? 0, expired ? 1 : 0);
        if (offset >= 1000 && !expired)
            assert.equal(got.accepted.length, 1);
    });
}
for (const capacity of [1, 2, 3, 4])
    for (const ms of [500, 1000, 2000, 3000, 5000, 10000, 20000]) {
        test(`viewport budget capacity=${capacity} requestedMs=${ms}`, async () => {
            const r = rig(posts(30), viewer(), cfg({ view: { ...cfg().view, viewportCapacity: capacity } }));
            const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
            const page = await nextPage(r.deps, s, r.viewer, CTX, 1);
            const accepted = await recordViews(r.deps, s, r.viewer, [{ serveId: page[0].serveId, visibleMs: ms, visibleFraction: 1 }], NOW + 10_000);
            const plausible = ms <= 12000 && ms <= capacity * 10000 + 2000;
            assert.equal(accepted.accepted.length, plausible && ms >= 1000 ? 1 : 0);
        });
    }
for (const batchLimit of [1, 2, 3, 5, 10])
    for (const size of [1, 2, 3, 5, 10, 20]) {
        test(`view report maxBatch=${batchLimit} size=${size}`, async () => {
            const r = rig(posts(40), viewer(), cfg({ view: { ...cfg().view, maxBatch: batchLimit } }));
            const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
            const page = await nextPage(r.deps, s, r.viewer, CTX, size);
            const at = NOW + size * 10_000;
            const res = await recordViews(r.deps, s, r.viewer, page.map(p => ({ serveId: p.serveId, visibleMs: 1000, visibleFraction: 1 })), at);
            assert.equal(res.rejected.batch_limit ?? 0, Math.max(0, size - batchLimit));
            assert.equal(res.accepted.length, Math.min(size, batchLimit));
        });
    }
test('duplicate receipt in the same request is rejected once and claimed once', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [one] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    const res = await recordViews(r.deps, s, r.viewer, [
        { serveId: one.serveId, visibleMs: 1000, visibleFraction: 1 },
        { serveId: one.serveId, visibleMs: 1000, visibleFraction: 1 }
    ], NOW + 5000);
    assert.equal(res.accepted.length, 1);
    assert.equal(res.rejected.duplicate, 1);
    assert.equal(r.store.claimLog().length, 1);
});
test('receipt is single-use even after a restart', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [one] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    const event = { serveId: one.serveId, visibleMs: 1000, visibleFraction: 1 };
    assert.equal((await recordViews(r.deps, s, r.viewer, [event], NOW + 4000)).accepted.length, 1);
    const restored = new MemoryStore(r.store.dump());
    r.deps.store = restored;
    const res = await recordViews(r.deps, s, r.viewer, [event], NOW + 5000);
    assert.equal(res.rejected.duplicate, 1);
    assert.equal(res.accepted.length, 0);
});
test('unknown server receipt is never accepted', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const res = await recordViews(r.deps, s, r.viewer, [{ serveId: 'fabricated', visibleMs: 1000, visibleFraction: 1 }], NOW + 5000);
    assert.equal(res.rejected.unknown, 1);
    assert.equal(res.accepted.length, 0);
});
test('wrong viewer cannot redeem an otherwise valid receipt', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [one] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    const res = await recordViews(r.deps, s, viewer({ id: 'intruder' }), [{ serveId: one.serveId, visibleMs: 1000, visibleFraction: 1 }], NOW + 5000);
    assert.equal(res.rejected.wrong_viewer, 1);
    assert.equal(r.store.claimLog().length, 0);
});
test('store failure means no claim, no exposure and no spent-view mutation', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [one] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    r.store.faults = 1;
    await assert.rejects(recordViews(r.deps, s, r.viewer, [{ serveId: one.serveId, visibleMs: 2000, visibleFraction: 1 }], NOW + 5000), /store unavailable/);
    assert.equal(r.store.claimLog().length, 0);
    assert.deepEqual(await r.store.exposures(r.viewer.id), {});
    assert.equal(await r.store.viewSpent(s.id), 0);
    const retried = await recordViews(r.deps, s, r.viewer, [{ serveId: one.serveId, visibleMs: 2000, visibleFraction: 1 }], NOW + 5000);
    assert.equal(retried.accepted.length, 1);
});
test('unverified claims never modify global impression or satisfaction counters', async () => {
    const list = posts(30);
    const r = rig(list);
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [one] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    const before = structuredClone(r.records.get(one.post.id));
    await recordViews(r.deps, s, r.viewer, [{ serveId: one.serveId, visibleMs: 2000, visibleFraction: 1 }], NOW + 5000);
    const after = r.records.get(one.post.id);
    assert.equal(after?.impressions, before?.impressions);
    assert.equal(after?.satisfied, before?.satisfied);
});
test('long idle time before serving cannot inflate the subsequent batch view budget', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const at = NOW + H;
    const [one] = await nextPage(r.deps, s, r.viewer, { ...CTX, now: at }, 1);
    const res = await recordViews(r.deps, s, r.viewer, [{ serveId: one.serveId, visibleMs: 10_000, visibleFraction: 1 }], at + 1000);
    assert.equal(res.rejected.implausible, 1);
});
test('spent view time survives JSON roundtrip and cannot be double charged', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const page = await nextPage(r.deps, s, r.viewer, CTX, 2);
    const evt = (serveId) => [{ serveId, visibleMs: 4000, visibleFraction: 1 }];
    await recordViews(r.deps, s, r.viewer, evt(page[0].serveId), NOW + 5000);
    r.deps.store = new MemoryStore(r.store.dump());
    const res = await recordViews(r.deps, s, r.viewer, evt(page[1].serveId), NOW + 10_000);
    assert.equal(res.accepted.length, 1);
    assert.equal(await r.deps.store.viewSpent(s.id), 8000);
});
test('exposure accumulation is viewer-specific', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [one] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    await recordViews(r.deps, s, r.viewer, [{ serveId: one.serveId, visibleMs: 2000, visibleFraction: 1 }], NOW + 5000);
    assert.ok((await r.store.exposures(r.viewer.id))[one.post.id]);
    assert.deepEqual(await r.store.exposures('other-viewer'), {});
});
// Contract coverage for still-unimplemented retry and trust controls.
test('concurrent conflicting client view reports automatically retry with bounded backoff', async () => {
    const r = rig(posts(20));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [item] = await nextPage(r.deps, s, r.viewer, CTX, 1);
    let calls = 0;
    const realCommit = r.deps.store.commitViews.bind(r.deps.store);
    r.deps.store.commitViews = async (a) => {
        calls++;
        if (calls === 1)
            throw new StoreConflict('simulated concurrent budget update');
        return realCommit(a);
    };
    const result = await recordViews(r.deps, s, r.viewer, [{ serveId: item.serveId, visibleMs: 1000, visibleFraction: 1 }], NOW + 3000);
    assert.equal(result.accepted.length, 1);
    assert.equal(calls, 2);
    const r2 = rig(posts(10));
    const s2 = await openSession(r2.deps, r2.viewer, CTX, { seed: 3 });
    const [second] = await nextPage(r2.deps, s2, r2.viewer, CTX, 1);
    let attempts = 0;
    r2.deps.store.commitViews = async () => { attempts++; throw new StoreConflict('permanent CAS conflict'); };
    await assert.rejects(recordViews(r2.deps, s2, r2.viewer, [{ serveId: second.serveId, visibleMs: 1000, visibleFraction: 1 }], NOW + 3000), StoreConflict);
    assert.equal(attempts, 3, 'retry policy must have a bounded attempt count');
});
test.todo('fraud-qualification pipeline rejects fabricated dwell telemetry before quality aggregation');
test('receipt timestamps from the future cannot be redeemed before their serve time', async () => {
    const r = rig(posts(30));
    const s = await openSession(r.deps, r.viewer, CTX, { seed: 1 });
    const [item] = await nextPage(r.deps, s, r.viewer, { ...CTX, now: NOW + 6000 }, 1);
    const result = await recordViews(r.deps, s, r.viewer, [{ serveId: item.serveId, visibleMs: 1000, visibleFraction: 1 }], NOW + 1000);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.implausible, 1);
    assert.deepEqual(await r.store.exposures(r.viewer.id), {});
});
