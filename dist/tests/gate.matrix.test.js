import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyGate } from '../src/index.js';
import { CTX, NOW, post, viewer } from './helpers.js';
// Meaningful independent cases, not repeat loops hidden inside a single test.
const ages = [null, 0, 1, 12, 13, 16, 17, 18, 21, 30, 65, 99];
const restrictions = [null, 0, 1, 12, 13, 16, 17, 18, 21, 30, 65, 99];
for (const surface of ['home', 'local', 'explore']) {
    for (const age of ages)
        for (const minAge of restrictions) {
            test(`gate age ${surface} viewer=${age} min=${minAge}`, () => {
                const got = createPolicyGate(60_000)(viewer({ age }), { ...CTX, surface })(post(1, { minAge }));
                const expected = minAge !== null && (age === null || age < minAge) ? 'age' : 'ok';
                assert.equal(got, expected);
            });
        }
}
const geoRules = [
    { id: 'open', g: null, allowed: () => true },
    { id: 'allow-NG', g: { allow: ['NG'] }, allowed: j => j === 'NG' },
    { id: 'allow-US', g: { allow: ['US'] }, allowed: j => j === 'US' },
    { id: 'allow-2', g: { allow: ['NG', 'US'] }, allowed: j => ['NG', 'US'].includes(j) },
    { id: 'allow-empty', g: { allow: [] }, allowed: () => false },
    { id: 'deny-NG', g: { deny: ['NG'] }, allowed: j => j !== 'NG' },
    { id: 'deny-US', g: { deny: ['US'] }, allowed: j => j !== 'US' },
    { id: 'deny-2', g: { deny: ['NG', 'US'] }, allowed: j => j !== 'NG' && j !== 'US' },
    { id: 'allowNG-denyNG', g: { allow: ['NG'], deny: ['NG'] }, allowed: () => false },
    { id: 'allowNG-denyUS', g: { allow: ['NG'], deny: ['US'] }, allowed: j => j === 'NG' },
    { id: 'allowNGUS-denyNG', g: { allow: ['NG', 'US'], deny: ['NG'] }, allowed: j => j === 'US' },
];
for (const surface of ['home', 'local', 'explore']) {
    for (const jurisdiction of ['NG', 'US', 'DE', '', 'XX'])
        for (const rule of geoRules) {
            test(`gate geo ${surface} ${jurisdiction || 'empty'} ${rule.id}`, () => {
                const v = viewer({ jurisdiction });
                const got = createPolicyGate(0)(v, { ...CTX, surface })(post(2, { geo: rule.g }));
                assert.equal(got, rule.g === null ? 'ok' : jurisdiction !== '' && rule.allowed(jurisdiction) ? 'ok' : 'geo');
            });
        }
}
const timeOffsets = [-3_600_000, -120_000, -60_000, -1, 0, 1, 30_000, 59_999, 60_000, 60_001, 120_000, 3_600_000];
for (const skew of [0, 1, 1000, 60_000, 120_000])
    for (const offset of timeOffsets) {
        test(`gate time skew=${skew} createdOffset=${offset}`, () => {
            const g = createPolicyGate(skew)(viewer(), CTX);
            assert.equal(g(post(3, { createdAt: NOW + offset })), offset > skew ? 'scheduled' : 'ok');
        });
    }
for (const expiryOffset of [-120000, -1000, -1, 0, 1, 1000, 60000])
    for (const surface of ['home', 'local', 'explore']) {
        test(`gate expiry ${surface} delta=${expiryOffset}`, () => {
            const got = createPolicyGate(0)(viewer(), { ...CTX, surface })(post(4, { expiresAt: NOW + expiryOffset }));
            assert.equal(got, expiryOffset <= 0 ? 'expired' : 'ok');
        });
    }
for (const mod of ['approved', 'pending', 'restricted', 'removed'])
    for (const eligible of [true, false])
        for (const vis of ['public', 'private'])
            for (const own of [true, false])
                for (const surface of ['home', 'local', 'explore']) {
                    test(`gate precedence ${surface} ${mod} eligible=${eligible} ${vis} own=${own}`, () => {
                        const p = post(5, { moderation: mod, feedEligible: eligible, visibility: vis, authorId: own ? 'viewer' : 'someone' });
                        const got = createPolicyGate(0)(viewer(), { ...CTX, surface })(p);
                        const expected = mod !== 'approved' ? 'moderation' : !eligible ? 'not_feed' : vis === 'private' && !own ? 'privacy' : 'ok';
                        assert.equal(got, expected);
                    });
                }
for (const choice of ['blockedAuthors', 'blockedBy', 'hiddenAuthors', 'hiddenPosts'])
    for (const another of ['blockedAuthors', 'blockedBy', 'hiddenAuthors', 'hiddenPosts'])
        for (const surface of ['home', 'local', 'explore']) {
            test(`gate block/hide precedence ${surface} ${choice}+${another}`, () => {
                const over = viewer();
                for (const k of [choice, another])
                    over[k] = [k === 'hiddenPosts' ? 'p-7' : 'author-7'];
                const g = createPolicyGate(0)(over, { ...CTX, surface });
                const isBlocked = [choice, another].some(k => k === 'blockedAuthors' || k === 'blockedBy');
                assert.equal(g(post(7)), isBlocked ? 'blocked' : 'hidden');
            });
        }
const badPosts = [
    { name: 'id empty', over: { id: '' } }, { name: 'id missing', over: { id: undefined } },
    { name: 'author empty', over: { authorId: '' } }, { name: 'author missing', over: { authorId: undefined } },
    { name: 'moderation missing', over: { moderation: undefined } },
    { name: 'visibility missing', over: { visibility: undefined } },
    { name: 'geo missing', over: { geo: undefined } },
    { name: 'geo array', over: { geo: [] } },
    { name: 'geo string', over: { geo: 'NG' } },
    { name: 'geo object no fields', over: { geo: {} } },
    { name: 'geo allow string', over: { geo: { allow: 'NG' } } },
    { name: 'geo deny string', over: { geo: { deny: 'NG' } } },
    { name: 'time NaN', over: { createdAt: NaN } },
    { name: 'time infinity', over: { createdAt: Infinity } },
    { name: 'time minus infinity', over: { createdAt: -Infinity } },
    { name: 'feedEligible missing', over: { feedEligible: undefined } },
    { name: 'feedEligible null', over: { feedEligible: null } },
    { name: 'expiresAt missing', over: { expiresAt: undefined } },
    { name: 'expiresAt NaN', over: { expiresAt: NaN } },
    { name: 'expiresAt Infinity', over: { expiresAt: Infinity } },
    { name: 'minAge missing', over: { minAge: undefined } },
    { name: 'minAge NaN', over: { minAge: NaN } },
    { name: 'minAge Infinity', over: { minAge: Infinity } },
];
for (const bp of badPosts)
    for (const surface of ['home', 'local', 'explore']) {
        test(`gate malformed post ${surface} ${bp.name}`, () => {
            assert.equal(createPolicyGate(60_000)(viewer(), { ...CTX, surface })(post(8, bp.over)), 'incomplete');
        });
    }
for (const missingField of ['blockedAuthors', 'blockedBy', 'hiddenAuthors', 'hiddenPosts', 'age'])
    for (const surface of ['home', 'local', 'explore']) {
        test(`gate incomplete viewer ${surface} ${missingField}`, () => {
            const v = viewer();
            v[missingField] = undefined;
            assert.equal(createPolicyGate(0)(v, { ...CTX, surface })(post(9)), 'incomplete');
        });
    }
for (const invalidTime of [NaN, Infinity, -Infinity])
    for (const surface of ['home', 'local', 'explore']) {
        test(`gate invalid ctx clock ${surface} ${String(invalidTime)}`, () => {
            assert.equal(createPolicyGate(0)(viewer(), { ...CTX, surface, now: invalidTime })(post(10)), 'incomplete');
        });
    }
// Document known defensive-validation requirements without changing the frozen 12:41 implementation.
for (const c of [{ name: 'negative age', v: viewer({ age: -1 }), p: post(1) },
    { name: 'negative minAge', v: viewer(), p: post(1, { minAge: -1 }) }]) {
    test(`hardening: fail closed on ${c.name}`, () => assert.equal(createPolicyGate(0)(c.v, CTX)(c.p), 'incomplete'));
}
