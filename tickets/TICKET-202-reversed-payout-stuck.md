# TICKET-202 — Reversed payout stuck, funds held
**Client:** Marea Pay S.A. · **Severity:** High · **Correlation id:** `CID-202`

> "A $600.00 crypto payout was reversed by your provider hours ago. In your dashboard it still shows **submitted** and the money is still locked in our account."

**What we know:** the transfer is in a non-terminal state and its reserved funds were never released. `grep CID-202 logs/incidents.ndjson` — look closely at what the provider actually sent.

**Your job:** find why a reversed payout never resolves, fix it so funds are released and the transfer reaches a terminal state, and add a regression test.
