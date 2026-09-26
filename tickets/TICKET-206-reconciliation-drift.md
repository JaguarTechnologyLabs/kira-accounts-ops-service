# TICKET-206 — Reconciliation doesn't net to zero (STRETCH)
**Reported by:** Finance · **Severity:** Medium · **Correlation id:** `CID-206`

> "End-of-day reconciliation between our ledger and the provider statement (`GET /reconciliation`, `data/provider_statement.csv`) is off. Even setting aside the open incidents, a few cents don't match."

**Your job (stretch):** separate the discrepancies caused by the other tickets from the systemic one, fix the systemic cause, and show reconciliation nets to **zero** once everything is fixed. Add a regression test.
