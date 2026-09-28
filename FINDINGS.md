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
*Status: Resolved*

* **Reproduction:**
  * Added regression test in `tests/regression.test.ts` creating a transfer with `scenario: 'out_of_order'`.
  * The mock provider delivered a `settled` webhook followed immediately by an out-of-order `failed` webhook.
  * Prior to the fix, the transfer status was overwritten to `'failed'`, the ledger recorded two separate `'release'` entries for a single `'hold'`, and the customer's available balance was overstated by the entire transfer amount ($771.75), presenting an active overdraft vulnerability.
* **Root Cause Mechanism:**
  * `applyProviderResult` blindly processed incoming provider events without checking the transfer's current state or checking for pre-existing ledger entries.
  * The initial `settled` event correctly posted a `debit` and a `release` (clearing the hold).
  * The subsequent out-of-order `failed` event executed a second `release` unconditionally and downgraded the transfer status to `failed`. Because available balance is derived via `sum(credit + release - debit - hold)`, two releases against one hold net an artificial credit balance.
* **Fix:**
  * **Terminal State Invariant:** Checked the current database state; if `currentStatus === 'settled'`, subsequent conflicting events (like `failed`) are ignored with a warning log and immediately discarded.
  * **Ledger Idempotency Check:** Queried `ledger_entries` for existing `debit` and `release` rows for the transfer before writing new ones, ensuring strict invariants: exactly one debit and at most one release per transfer across any ordering of webhook events.
* **Prevention (Why it can't recur):**
  * Settlement is treated as the immutable source of truth: once real money has cleared with the payment rail, subsequent webhook deliveries cannot retract the settlement.
  * Ledger entries are guarded against duplicate emission, preserving double-entry accounting integrity regardless of webhook delivery order or network retries.

---

## TICKET-204: Payout stuck in `created` after an API crash (`CID-204`)
*Status: Resolved*

* **Reproduction:**
  * Added automated regression test in `tests/regression.test.ts` injecting a simulated crash (`faults.crashMidRequestFor = 'idem-204'`) during `createOutboundTransfer`.
  * Prior to the fix, the process crash occurred after inserting the transfer and writing the ledger `hold`, but before writing to `outbox`.
  * As a result, the transfer remained orphaned in status `'created'`, the funds remained locked in `'hold'` indefinitely, zero outbox tasks were enqueued, and any retry by the client with the same idempotency key was either blocked or returned the dead transfer without dispatching it.
* **Root Cause Mechanism:**
  * Non-atomic persistence across multiple relational tables: `createOutboundTransfer` performed three sequential, independent queries (`INSERT INTO transfers`, `INSERT INTO ledger_entries`, and `INSERT INTO outbox`) without enclosing them in a database transaction block.
  * If the Node.js API process crashed, lost network connectivity, or terminated midway through request handling, partial state was committed: the transfer and hold persisted while the outbox queue entry was never created.
* **Fix:**
  * Enclosed the entire creation workflow within `db.transaction(async (tx) => { ... })` in `src/transfers.ts`.
  * Routed all writes and queries (`insert into transfers`, `post` hold entry, and `insert into outbox`) through the transaction context `tx`.
  * If an unhandled exception or process termination occurs prior to commit, PostgreSQL automatically issues a `ROLLBACK`, discarding the uncommitted transfer record and ledger hold completely.
  * Included a double-check within the transaction block (`getByIdemKey(tx, ...)`) so that concurrent retries queued behind the transaction mutex resolve the winner cleanly without race conditions.
* **Prevention (Why it can't recur):**
  * **Atomicity & Transactional Outbox:** Either all three records (transfer, hold, outbox event) are committed together, or none of them are.
  * If the server crashes, the client's available balance is 100% untouched ($0 held), and subsequent retries with the same idempotency key can execute smoothly from a clean state.

---

## TICKET-205: Provider paid twice after a timeout (`CID-205`) [Stretch]
*Status: Resolved*

* **Reproduction:**
  * Added automated regression test in `tests/regression.test.ts` executing a transfer with `scenario: 'timeout_once'`.
  * Running the worker (`processOutbox`) across two passes reproduced the failure: the provider statement recorded **two** separate $1,200.00 payouts (`provider.submissions.length === 2`) for a single transfer, and the system raised a `webhook.unknown_transfer` warning for the orphaned first submission reference.
* **Root Cause Mechanism:**
  * Downstream non-idempotent retries: While incoming requests from clients were deduplicated at our API ingress (Ticket 201), the background worker (`src/outbox.ts`) failed to propagate an idempotency key downstream to the payment rail when executing `provider.submit(t)`.
  * When a transient network timeout occurred *after* the provider had already received and committed the payout, our worker threw `ProviderTimeout` and retained the task in `pending` status without recording the provider's reference.
  * On the subsequent retry pass, the worker submitted the transfer again without an idempotency key. The provider rail interpreted this as a completely separate payout request, generated a second reference, and executed a duplicate debit of $1,200.00 to the beneficiary.
  * When the late webhook from the first submission arrived, our system logged `webhook.unknown_transfer` because the transfer had already been overwritten with the second submission's reference.
* **Fix:**
  * In `src/outbox.ts`, updated `provider.submit(t)` to pass the unique internal transfer ID as the idempotency key: `provider.submit(t, t.id)`.
  * When retrying after a timeout, the provider recognizes `t.id` in its submissions registry, deduplicates the submission, returns the original `provider_ref`, and avoids creating duplicate payout instructions.
* **Prevention (Why it can't recur):**
  * **End-to-End Idempotency Propagation:** Idempotency is enforced end-to-end: client ➔ Kira ➔ banking provider. Every outbound HTTP call to an external payment processor must attach our immutable transfer ID as an idempotency header/key.
  * Automated regression test asserts that even under simulated network timeouts, `provider.submissions` contains exactly 1 payment record for the transfer.

---

## TICKET-206: Reconciliation doesn't net to zero (`CID-206`) [Stretch]
*Status: Resolved*

* **Reproduction:**
  * Implemented an automated regression test in `tests/regression.test.ts` executing end-of-day reconciliation across seeded and routine transfers with fractional cent fee calculations (e.g. $1,555.00, $1,724.00, $883.00).
  * In the baseline setup (`src/demo.ts`), reconciliation failed with `diff = 3c`, `fee_mismatches = 3` (transfers `TX-0004`, `TX-0005`, and `TX-0006`), and `statement-only payouts = 1` (prior to Ticket 205 fix).
* **Root Cause Mechanism:**
  * Two compounding root causes drove reconciliation discrepancies:
    1. **Duplicate Payouts via Missing Downstream Idempotency (Ticket 205):** Worker timeout retries created an unauthorized second payout on the provider rail, creating an un-matched entry (`statementOnly = 1`) and a 120,000 cent ($1,200.00) imbalance.
    2. **Algorithmic Divergence in Fee Rounding (Truncation vs Round Half-Up):**
       * In `src/providers.ts` (`statement()`), the banking provider calculates platform fees using standard Round Half-Up arithmetic: `Math.floor(amount_cents * 0.029 + 0.5)`.
       * In Kira's platform (`src/money.ts`), `feeCents` calculated fees using integer truncation: `Math.floor(amountCents * rate)`.
       * For transfer amounts where multiplying by 2.9% yields fractional cents $\ge 0.5$, truncation rounds downwards to the nearest cent while the banking partner rounds upwards:
         * `TX-0004` ($1,555.00 = 155,500c): $155,500 \times 0.029 = 4,509.5$c. Kira calculated 4,509c; provider charged 4,510c (1c discrepancy).
         * `TX-0005` ($1,724.00 = 172,400c): $172,400 \times 0.029 = 4,999.6$c. Kira calculated 4,999c; provider charged 5,000c (1c discrepancy).
         * `TX-0006` ($883.00 = 88,300c): $88,300 \times 0.029 = 2,560.7$c. Kira calculated 2,560c; provider charged 2,561c (1c discrepancy).
       * Consequently, Kira under-collected 3 cents in platform fees across these transactions, causing our internal ledger to drift from the partner bank's actual settlement statement.
* **Fix:**
  * Updated `feeCents` in `src/money.ts` to use `Math.round(amountCents * rate)`, which implements standard Round Half-Up rounding for monetary values (identical in precision and output to `Math.floor(amountCents * rate + 0.5)`).
  * Combined with the fix in Ticket 205 (which eliminated duplicate statement payouts), reconciliation now nets to exactly `0c` variance, with `0` fee mismatches, `0` statement-only entries, and `0` ledger-only entries.
* **Prevention (Why it can't recur):**
  * Automated regression suite verifies that end-of-day reconciliation produces zero drift and zero fee mismatches across edge-case payment amounts.
  * Explicit rounding specifications: All monetary calculations in the codebase standardize on Round Half-Up to maintain complete numerical parity with external banking rails and regulatory settlement standards.

