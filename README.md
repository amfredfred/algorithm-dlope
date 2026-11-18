# Dlope Feed — Unified TypeScript Regression Package (verified 2026-11-18)

**Source under test:** `src/feed.ts` (corrected from the earlier 13:16 upload and the initial hardening attempt). `src/index.ts` re-exports this exact source to preserve the original 12:41 suite's imports. **No Dlope production repository or database was modified.**

## Reproduce

Requires Node.js 22+; package pins TypeScript ~5.8.3 and @types/node ^22.

```sh
npm install
npm run typecheck
npm test
```

`npm test` builds the TypeScript source and TypeScript tests under `dist/`, then runs the full 12:41 suite **against the corrected feed implementation**, plus the 62 hardening regression tests, in a single Node test execution. The runner writes full TAP results to `reports/regression.tap`; it does not hide failures. `npm run test:tap` emits the full TAP stream; `npm run test:spec` emits case names. To repeat the dataset and synthetic benchmark checks: `npm run fixture:report` and `npm run benchmark`.

### Actual results from this container

- `npm run typecheck`: **pass**, strict TypeScript 5.8.3.
- `npm test`: **4,570 registered; 4,568 passed; 0 failed; 0 skipped; 2 TODO**.
- 12:41 legacy suite: **4,508 registered** (originally 4,497 pass, 11 TODO). After technical TODO activation and necessary compatibility corrections: **4,506 pass, 2 TODO**.
- Previous hardening suite: **62 tests included and passed** (the earlier report first mentioned 61 and then 62; the exact installed suite contains 62).
- The test cases themselves include thousands of deterministic fuzz/property iterations. These are *iterations within named cases*, not extra top-level `node:test` cases.
- Original `dummies.json`: **2,000 posts**, checked against all its actual regions, including the intentional missing viewer region.
- Synthetic benchmark executed. Results are only from the in-memory reference implementation, **not** a cloud performance SLO.

### Two remaining TODOs

1. Guarantee no duplicate delivery across **independently opened concurrent sessions after a qualified claim**. That requires a product-consistent cross-session policy and transactional behavior in a real session/DB layer; not claimed as implemented.
2. **Independently fraud-verified quality aggregation.** Client-supplied visible-time claims are not trusted as verification; the algorithm does not implement a verified quality pipeline. The TODO remains explicit.

See `reports/TEST_REPORT.md` and `reports/results.json` for details. A green result is not approval for production.

## Files

- `src/feed.ts`: corrected algorithm.
- `src/index.ts`: compatibility re-export for original test suite and typings.
- `tests/*.test.ts`: full 12:41 regression suite, with 9 TODOs replaced with real assertions and documented compatibility corrections.
- `test/*.test.mjs`: all 62 tests from the original hardening package.
- `fixtures/dummies.json`: 2,000-post saved dataset.
- `reports/regression.tap`: full 4,570-case output.
- `reports/results.json`: machine-readable counts and TODO names.
- `reports/TEST_REPORT.md`: failure triage and status.
- `diffs/*`: exact code and test diffs. **Review test adaptations; original tests were not silently changed.**
- `baselines/*`: original 12:41 source and 13:16 uploaded source.
- `original-suites/12-41-original-4508-tests.zip`: unmodified earlier test archive for independent verification.

## Dlope Rev19 product boundaries

Square is canonical, regional and chronological. For Me ranks **eligible Square roots**; profile remains newest-first; posts and threads are not duplicated for feed ranking. Region preference is not a geographic restriction. Trust remains a safety gate/cap and not a positive organic boost. This package does not introduce a follower graph, paid ranking, or tracking of unverified client claims as verified quality.

## Integration is not finished

The `MemoryStore`, `buildIndex` and `buildAuthority` implementations are **reference/in-memory adapters**. Real indexes need eligibility + viewer-scope filtering **before LIMIT**, authoritative policy revalidation before delivery, and transactionally enforced compare-and-set semantics for deliveries and view claims. Real repository integration, paid/auth/etc. controls, external load tests, trust cap and weight approval are not represented as complete.
