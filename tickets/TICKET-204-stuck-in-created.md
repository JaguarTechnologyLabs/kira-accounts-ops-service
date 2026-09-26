# TICKET-204 — Payout stuck in "created", never reached the provider
**Client:** Marea Pay S.A. · **Severity:** High · **Correlation id:** `CID-204`

> "A $400.00 payout has been 'created' for hours, the funds are held, and your provider has no record of it."

**What we know:** the API process crashed while handling this request (there is an `api.crash` entry in the logs). The transfer exists with a hold, but the worker never picked it up. `grep CID-204 logs/incidents.ndjson`.

**Your job:** find the design flaw that lets a crash leave money in this state, fix it so a crash mid-request can never strand funds, and add a regression test (the chaos hook in `src/faults.ts` lets you simulate the crash).
