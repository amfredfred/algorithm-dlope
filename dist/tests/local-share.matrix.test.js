import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLocalShare } from '../src/index.js';
import { post, seeded } from './helpers.js';
const lengths = [0, 1, 2, 3, 5, 8, 10, 15, 25, 40, 65, 100];
const shares = [-10, -1, 0, 0.05, 0.1, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.66, 0.75, 0.8, 0.9, 1, 1.5, 2, NaN, Infinity];
const patterns = ['none', 'all', 'alternating', 'third', 'first-half', 'second-half', 'minority', 'majority', 'random'];
for (const n of lengths)
    for (const share of shares)
        for (const pattern of patterns) {
            test(`local-share invariant n=${n} share=${String(share)} pattern=${pattern}`, () => {
                const rand = seeded(n * 233 + (Number.isFinite(share) ? Math.floor(share * 101) : 997) + patterns.indexOf(pattern) * 37);
                const items = Array.from({ length: n }, (_, i) => {
                    const local = pattern === 'none' ? false : pattern === 'all' ? true : pattern === 'alternating' ? i % 2 === 0 :
                        pattern === 'third' ? i % 3 === 0 : pattern === 'first-half' ? i < n / 2 : pattern === 'second-half' ? i >= n / 2 :
                            pattern === 'minority' ? i % 7 === 0 : pattern === 'majority' ? i % 7 !== 0 : rand() < 0.45;
                    return post(`${n}-${pattern}-${i}`, { regionId: local ? 'local' : 'foreign' });
                });
                const before = items.map(p => p.id);
                const result = withLocalShare(items, 'local', share);
                assert.equal(result.length, n);
                assert.deepEqual(result.map(p => p.id).sort(), before.sort());
                for (const region of ['local', 'foreign'])
                    assert.deepEqual(result.filter(p => p.regionId === region).map(p => p.id), items.filter(p => p.regionId === region).map(p => p.id));
                const effective = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
                const totalLocal = items.filter(p => p.regionId === 'local').length;
                let localCount = 0;
                for (let i = 0; i < n; i++) {
                    if (result[i].regionId === 'local')
                        localCount++;
                    const required = Math.min(Math.floor(effective * (i + 1) + 1e-9), totalLocal);
                    assert.ok(localCount >= required, `prefix=${i + 1}: local=${localCount} < floor=${required}`);
                }
                if (effective === 0)
                    assert.deepEqual(result.map(p => p.id), items.map(p => p.id));
                if (effective === 1)
                    assert.ok(result.slice(0, totalLocal).every(p => p.regionId === 'local'));
            });
        }
