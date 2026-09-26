# TICKET-205 — Provider says it paid twice; we only see one transfer (STRETCH)
**Reported by:** Provider reconciliation · **Severity:** High · **Correlation id:** `CID-205`

> "Your provider's statement shows **two** $1,200.00 payouts to the same vendor. Your system shows one transfer, settled once."

**What we know:** the provider timed out on the first submission attempt. There is a `webhook.unknown_transfer` warning in the logs. Compare `GET /provider/submissions` with the transfer. `grep CID-205 logs/incidents.ndjson`.

**Your job (stretch):** explain why a timeout led to a double payment, fix the submission path so a retry can never pay twice, and add a regression test.
