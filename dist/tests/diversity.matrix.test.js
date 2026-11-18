import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diversify } from '../src/index.js';
import { post, seeded } from './helpers.js';
const caps = [1, 2, 3, 4, 8];
const windows = [1, 2, 3, 5, 10, 20];
for (const cap of caps)
    for (const window of windows)
        for (let seed = 0; seed < 16; seed++) {
            test(`diversity: cap=${cap} window=${window} distribution seed=${seed}`, () => {
                const rnd = seeded(seed * 991 + cap * 43 + window * 103);
                const n = seed % 4 === 0 ? 0 : seed % 4 === 1 ? 10 : seed % 4 === 2 ? 30 : 60;
                const uniqueAuthors = 1 + Math.floor(rnd() * Math.max(2, Math.floor(n / 3)));
                const sequence = Array.from({ length: n }, (_, i) => post(`${seed}-${i}`, { authorId: `a${Math.floor(rnd() * uniqueAuthors)}` }));
                const prior = Array.from({ length: seed % 5 }, (_, i) => `a${Math.floor(rnd() * uniqueAuthors)}`);
                const { order, relaxedFrom } = diversify(sequence, cap, window, prior);
                assert.equal(order.length, sequence.length);
                assert.deepEqual(order.map(x => x.id).sort(), sequence.map(x => x.id).sort());
                for (let author = 0; author < uniqueAuthors; author++) {
                    const a = `a${author}`;
                    assert.deepEqual(order.filter(p => p.authorId === a).map(p => p.id), sequence.filter(p => p.authorId === a).map(p => p.id));
                }
                assert.ok(relaxedFrom === null || (relaxedFrom >= 0 && relaxedFrom < order.length));
                const stop = relaxedFrom ?? order.length;
                const allAuthors = prior.concat(order.map(p => p.authorId));
                for (let idx = 0; idx < stop; idx++) {
                    const absolute = prior.length + idx;
                    const current = allAuthors[absolute];
                    const near = allAuthors.slice(Math.max(0, absolute - window + 1), absolute + 1);
                    assert.ok(near.filter(a => a === current).length <= cap, `author cap violated before relaxation at ${idx}; prior=${prior.join(',')} sequence=${order.map(p => p.authorId).join(',')}`);
                }
            });
        }
for (const cap of [1, 2, 3, 10])
    for (const window of [1, 2, 4, 10])
        for (const authors of [1, 2, 3, 5, 10, 20]) {
            test(`diversity: no artificial relaxation with cap=${cap}, window=${window}, authors=${authors}`, () => {
                const list = Array.from({ length: authors }, (_, i) => post(i, { authorId: `unique-${i}` }));
                const result = diversify(list, cap, window);
                assert.equal(result.relaxedFrom, null);
                assert.deepEqual(result.order.map(x => x.id), list.map(x => x.id));
            });
        }
for (const cap of [1, 2, 3])
    for (const window of [2, 4, 10])
        for (const n of [4, 10, 20, 50]) {
            test(`diversity: saturated single author must relax cap=${cap} window=${window} n=${n}`, () => {
                const list = Array.from({ length: n }, (_, i) => post(i, { authorId: 'single' }));
                const { order, relaxedFrom } = diversify(list, cap, window);
                assert.equal(order.length, n);
                if (n > cap && window > cap)
                    assert.notEqual(relaxedFrom, null);
            });
        }
