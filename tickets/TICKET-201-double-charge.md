# TICKET-201 — Vendor paid twice
**Client:** Marea Pay S.A. · **Severity:** High · **Correlation id:** `CID-201`

> "Our integration sent ONE $500.00 payout. The request timed out on our side, so our client library retried — both attempts carried the **same Idempotency-Key**. The vendor was paid **twice** and our balance was debited twice."

**What we know:** two `outbound` transfers exist for `idem-201`. Our existing test for "retry with the same key" **passes** (`npm test`), and a sequential retry against the running API does not reproduce it. `grep CID-201 logs/incidents.ndjson`.

**Hint:** the client's two attempts were in flight **at the same time**. To see it, start two calls together inside one process, the way `src/bootstrap.ts` seeds this incident; one call after the other will not show it.

**Your job:** find the actual root cause, ship a production-ready fix, and add a regression test that **reproduces the failure before your fix and passes after it.**
