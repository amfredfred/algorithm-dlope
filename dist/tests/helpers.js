import { EXPERIMENTAL_CONFIG, MemoryStore, buildAuthority, buildIndex, createPolicyGate, } from '../src/index.js';
export const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const H = 3_600_000;
export const CTX = { surface: 'home', now: NOW };
export function cfg(over = {}) {
    return { ...structuredClone(EXPERIMENTAL_CONFIG), ...over };
}
export function post(i, over = {}) {
    const id = `p-${i}`;
    return {
        id, authorId: `author-${i}`, regionId: 'local', topics: ['a'], createdAt: NOW - H,
        impressions: 100, satisfied: 20, version: 1, moderation: 'approved',
        visibility: 'public', geo: null, expiresAt: null, minAge: null, feedEligible: true, ...over,
    };
}
export function viewer(over = {}) {
    return { id: 'viewer', regionId: 'local', jurisdiction: 'NG', age: 30, interests: ['a'],
        hiddenAuthors: [], hiddenPosts: [], blockedAuthors: [], blockedBy: [], exposures: {}, ...over };
}
export function policy(v) {
    return { jurisdiction: v.jurisdiction, age: v.age, hiddenAuthors: v.hiddenAuthors, hiddenPosts: v.hiddenPosts,
        blockedAuthors: v.blockedAuthors, blockedBy: v.blockedBy };
}
export function rig(posts, v = viewer(), c = cfg(), wrap) {
    const store = new MemoryStore();
    store.seedExposures(v.id, v.exposures);
    const records = new Map(posts.map(p => [p.id, structuredClone(p)]));
    const policies = new Map([[v.id, policy(v)]]);
    const index = buildIndex(posts, c, NOW);
    const errors = [];
    const deps = {
        cfg: c, index: wrap?.(index) ?? index, authority: buildAuthority(records, policies),
        store, gate: createPolicyGate(c.futureSkewMs), onError: (where, error) => { errors.push({ where, error }); }
    };
    return { deps, store, records, policies, errors, viewer: v, cfg: c };
}
export function posts(n, over = {}) { return Array.from({ length: n }, (_, i) => post(i, over)); }
export function seeded(n) { let s = n >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
export const isPermutation = (a, b) => a.length === b.length &&
    a.slice().sort().every((v, i) => v === b.slice().sort()[i]);
