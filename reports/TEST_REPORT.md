# Dlope Algorithm — Re-audit and Unified Regression Report

**Date:** 2026-11-18  
**Runtime:** Node.js v22.16.0; TypeScript 5.8.3, `strict: true`  
**Product specification checked:** Dlope Project Bible Revision 19; no production repository integration was available.  
**Algorithm baseline:** pasted source at 13:16 (not the unavailable 12:45 snapshot).

## Results

| Check | Observed result |
|---|---|
| Strict TypeScript typecheck | PASS |
| TypeScript build | PASS |
| Unified `node:test` suite | 4,570 registered, **4,568 pass**, **0 fail**, 0 skipped, 2 TODO |
| Original 12:41 suite | 4,508 registered; 4,506 pass and 2 TODO after corrections |
| Previous hardening suite | 62 registered; 62 pass |
| Dlope library dataset (2,000 posts) | PASS |
| In-memory synthetic benchmark | Completed; see `benchmark.log` / `reports/benchmark-results.json` |

This was **not** 4,568 production end-to-end tests. Nearly all tests run against in-memory fixtures; many scenario/property iterations occur inside a smaller number of named cases.

## What failed when the older 4,508-case tests were first run against the previous patch

**First combined run:** 4,570 registered, 4,546 passed, **13 failed**, 11 TODO. These failures disproved my earlier claim that the patch had been fully validated against your existing regression suite.

| Failed cases | Cause | Resolution |
|---:|---|---|
| 3 | Previous patch changed the established owner-private gate behavior for own posts | Restored owner access, retained denial to other viewers. Keep policy gating authoritative at delivery |
| 8 | `buildIndex` incorrectly reused eligibility-filtered discovery lookup for `byIds`, dropping a valid historical/direct ID lookup case | Separate raw ID lookup from safe discovery indexes; authorization still runs in caller |
| 1 | Legacy stale-authority test set `satisfied=999` while `impressions=100`, violating now-enforced score integrity | Preserved the *stale authority* assertion but amended the fixture to `impressions=1000` so it is internally valid |
| 1 | Legacy test forged an extra serve receipt with no cursor advance, bypassing legitimate delivery ordering | Retained anti-forgery enforcement and converted that legacy test into a negative case; existing normal receipt must still be single-use |

The final test diffs are recorded in `diffs/12-41-tests-adaptations.diff` and `diffs/previous-tests-adaptations.diff`. **The two test-fixture changes are not claimed as algorithmic fixes.**

## Previously deferred tests activated

Nine technical TODOs in the legacy suite are now real passing tests:

- Negative viewer age; negative minimum post age (2).
- Exhausted local bucket is not redundantly re-fetched during cross-region widening.
- Fresh tier precedes recycled tier through diversity ordering.
- Local quota respected when author-diversity constraints make it feasible.
- Fresh/recycled isolation remains after tail rebuild.
- Invalid page size cannot issue receipts.
- Bounded CAS retries for conflicting view claims.
- Reject view receipts claimed before their serve timestamp.

The remaining 2 TODOs need either approved policy + persistent DB enforcement (cross-session duplicate guarantees) or a separate verified fraud/quality system. They are not counted as passes.

## Existing hardening retained

- Retrieval filters eligibility before bucket limits, with authority recheck on serve.
- Region-first diversification with cross-region fallback.
- Malformed geo arrays fail closed.
- Unique IDs, per-author sliding window, deterministic sampling across async bucket requests.
- Server receipt and session CAS checks; cumulative view budgets; view claims do not increment post-quality counters.
- Privacy/moderation checks before delivery; stored/policy edits trigger appropriate tail invalidation.

## Release blockers and limitations

- **No production Dlope repository update or deployed service tests.** No actual DB adapter or real concurrent transaction implementation was reviewed.
- No independent trust safety cap or fraud-qualified quality pipeline was added; trust must not be a positive rank boost.
- The numeric experimental configuration needs calibration and explicit release approval.
- The local-share floor can conflict with author diversity; author diversity currently takes precedence when simultaneously infeasible. This is documented behavior, not a guarantee of exact regional quotas for every possible inventory mix.
- The 12:45 snapshot was not available for a literal historical diff.

**Release status: Reference build passes included tests; production readiness NOT established.**
