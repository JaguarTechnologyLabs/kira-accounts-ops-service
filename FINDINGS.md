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
*Status: Resolved*

* **Reproduction:**
  * Implemented an automated regression test in `tests/regression.test.ts` executing concurrent requests via `Promise.all` with identical parameters and `idempotency_key = 'idem-201'`.
  * Prior to the fix, the test failed with assertion mismatch (`TX-0002` vs `TX-0003`): the database persisted 2 transfer rows, registered 2 `hold` entries in `ledger_entries`, and enqueued 2 outbox events, reproducing the double payout reported by Marea Pay.
* **Root Cause Mechanism:**
  * The transfer creation logic in `src/transfers.ts` used a non-atomic "read-then-write" pattern (`getByIdemKey` followed by `INSERT`).
  * Crucially, the schema definition in `src/db.ts` lacked a `UNIQUE` constraint or unique index on `transfers.idempotency_key`.
  * When retries were initiated concurrently (e.g. client HTTP timeout retry), both requests executed the `SELECT` concurrently before either completed the `INSERT`. Both observed zero existing rows, proceeded to insert distinct transfers, reserved funds twice in the ledger, and enqueued two separate provider submission tasks.
* **Fix:**
  * **Database layer (`src/db.ts`):** Enforced a database-level `UNIQUE` constraint on `transfers(idempotency_key)`.
  * **Application layer (`src/transfers.ts`):** Enclosed the `INSERT` query in a `try/catch` block. When a concurrent collision occurs, PostgreSQL raises a unique constraint violation (`23505`). The catch block intercepts this, retrieves the winning record via `getByIdemKey`, and returns it immediately.
* **Prevention (Why it can't recur):**
  * **Database-enforced ACID guarantees:** The relational engine guarantees uniqueness at the persistence layer, eliminating application-level race conditions across concurrent threads or distributed instances.
  * **Zero side effects on collisions:** The losing request exits immediately upon resolving the winner, completely bypassing subsequent ledger `hold` calls and outbox event enqueueing.

---

## TICKET-202: Reversed payout stuck, funds held (`CID-202`)
*Status: Resolved*

* **Reproduction:**
  * Implemented an automated regression test in `tests/regression.test.ts` creating a transfer with `scenario: 'reversed'`.
  * After executing the worker (`processOutbox`), the transfer remained stuck in `submitted` and the account's available balance remained reduced by the held funds ($600.00 + $17.40 fee = $617.40 held).
* **Root Cause Mechanism:**
  * The state-machine processor in `src/transfers.ts` (`applyProviderResult`) evaluated incoming webhook statuses using a series of conditional branches: `pending`, `settled`, `failed`, and `returned`.
  * The `'reversed'` status payload sent by crypto and card providers was completely missing from the branch logic.
  * When the provider sent the reversal webhook, the function completed without executing any state update or ledger entry, leaving the transfer in `submitted` and stranding the reserved funds indefinitely.
* **Fix:**
  * Added a dedicated branch for `'reversed'` in `applyProviderResult` (`src/transfers.ts`).
  * Emits an entry of type `'release'` in `ledger_entries` for the total held amount (`amount_cents + fee_cents`), returning funds to the available balance.
  * Updates the transfer's status to the terminal state `'reversed'`.
* **Prevention (Why it can't recur):**
  * The state transition handler now explicitly maps all provider settlement outcomes defined in the provider interface.
  * The regression test enforces that any reversed payout must reach terminal status and restore 100% of the account's available balance.

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
