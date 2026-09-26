# TICKET-203 — Payout shows "failed" but the provider paid it; balance looks too high
**Client:** Marea Pay S.A. · **Severity:** Critical (overdraft risk) · **Correlation id:** `CID-203`

> "Your provider confirmed a $750.00 payout settled. Your dashboard shows it **failed**, and our available balance is *higher* than it should be — we're worried we could spend money that's already gone."

**What we know:** the provider delivered more than one webhook for this payout. Check the ledger entries for the transfer and the order of events in `grep CID-203 logs/incidents.ndjson`.

**Your job:** explain exactly how the balance became overstated, fix the state handling so it cannot happen for any sequence of provider events, and add a regression test.
