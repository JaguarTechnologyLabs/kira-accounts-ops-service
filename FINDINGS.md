# Incident Findings & Root Cause Analysis

This document details the root-cause analysis, reproduction methodologies, fixes, and prevention mechanisms for each production incident in the Kira Accounts Ops Service.

---

## Systemic Observations & Production Hardening Notes

### Finding 0: Absence of Pre-Transfer Balance Check (Overdraft & Concurrency Vulnerability)
* **Location:** `src/transfers.ts` (`createOutboundTransfer`)
* **Observation:** The endpoint accepts outbound transfers, calculates fees, inserts the transfer record, and immediately applies a `hold` without verifying whether the account has sufficient available balance (`availableCents`).
* **Operational Impact:** While this does not impact the seeded test dataset (where the account starts with $20,000.00 funding), in a production environment an account could trigger arbitrary holds and push its available balance into negative numbers, creating an overdraft risk.
* **Recommended Production Hardening:** In a high-volume production service, an atomic check-and-reserve transaction using database-level locking (`SELECT ... FOR UPDATE` on account balance) or a check constraint preventing negative available balances should be implemented.

---

## TICKET-201: Vendor paid twice on a retried request (`CID-201`)
*Status: Open (Pending Fix)*

* **Reproduction:**
* **Root Cause Mechanism:**
* **Fix:**
* **Prevention (Why it can't recur):**

---

## TICKET-202: Reversed payout stuck, funds held (`CID-202`)
*Status: Open (Pending Fix)*

* **Reproduction:**
* **Root Cause Mechanism:**
* **Fix:**
* **Prevention (Why it can't recur):**

---

## TICKET-203: Provider paid, we show "failed", balance overstated (`CID-203`)
*Status: Open (Pending Fix)*

* **Reproduction:**
* **Root Cause Mechanism:**
* **Fix:**
* **Prevention (Why it can't recur):**

---

## TICKET-204: Payout stuck in `created` after an API crash (`CID-204`)
*Status: Open (Pending Fix)*

* **Reproduction:**
* **Root Cause Mechanism:**
* **Fix:**
* **Prevention (Why it can't recur):**

---

## TICKET-205: Provider paid twice after a timeout (`CID-205`) [Stretch]
*Status: Open (Pending Fix)*

* **Reproduction:**
* **Root Cause Mechanism:**
* **Fix:**
* **Prevention (Why it can't recur):**

---

## TICKET-206: Reconciliation doesn't net to zero (`CID-206`) [Stretch]
*Status: Open (Pending Fix)*

* **Reproduction:**
* **Root Cause Mechanism:**
* **Fix:**
* **Prevention (Why it can't recur):**
