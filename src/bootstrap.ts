import fs from 'fs';
import path from 'path';
import type { PGlite } from '@electric-sql/pglite';
import { creditInbound, createOutboundTransfer } from './transfers.js';
import { processOutbox } from './outbox.js';
import { faults } from './faults.js';
import * as provider from './providers.js';
import { resetLog, log } from './logger.js';

// Seeds a deterministic dataset reproducing the open incidents. Fresh, in-memory, every run.
export async function seedInto(db: PGlite): Promise<string> {
  resetLog(); provider.resetProvider();
  const acc = 'ACC-MAREA';
  await db.query(`insert into accounts(id, name) values ($1,$2)`, [acc, 'Marea Pay S.A.']);
  await creditInbound(db, { account_id: acc, amount_cents: 2_000_000, memo: 'initial funding' });
  log('account.funded', { account_id: acc, amount_cents: 2_000_000 });

  // TICKET-201: the client's integration fired the same request twice at once (retry on timeout)
  const c201 = 'CID-201';
  await Promise.all([
    createOutboundTransfer(db, { account_id: acc, rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201', correlation_id: c201 }),
    createOutboundTransfer(db, { account_id: acc, rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201', correlation_id: c201 }),
  ]);

  // TICKET-202: provider reverses a crypto payout
  await createOutboundTransfer(db, { account_id: acc, rail: 'crypto', amount_cents: 60_000, idempotency_key: 'idem-202', scenario: 'reversed', correlation_id: 'CID-202' });

  // TICKET-203: provider webhooks for this payout arrive out of order / re-sent
  await createOutboundTransfer(db, { account_id: acc, rail: 'ach', amount_cents: 75_000, idempotency_key: 'idem-203', scenario: 'out_of_order', correlation_id: 'CID-203' });

  // TICKET-204: the API process crashed mid-request (chaos hook)
  faults.crashMidRequestFor = 'idem-204';
  try { await createOutboundTransfer(db, { account_id: acc, rail: 'ach', amount_cents: 40_000, idempotency_key: 'idem-204', correlation_id: 'CID-204' }); }
  catch (e: any) { log('api.crash', { error: e.message, idempotency_key: 'idem-204' }, 'CID-204', 'error'); }
  faults.crashMidRequestFor = undefined;

  // TICKET-205: the provider times out once for this payout
  await createOutboundTransfer(db, { account_id: acc, rail: 'ach', amount_cents: 120_000, idempotency_key: 'idem-205', scenario: 'timeout_once', correlation_id: 'CID-205' });

  // TICKET-206: routine payouts used by end-of-day reconciliation
  for (const amt of [155_500, 172_400, 88_300, 420_000, 250_900]) {
    await createOutboundTransfer(db, { account_id: acc, rail: 'ach', amount_cents: amt, idempotency_key: `idem-206-${amt}`, correlation_id: 'CID-206' });
  }

  // The worker runs (two passes, as it would on its schedule)
  await processOutbox(db, 'WORKER-pass-1');
  await processOutbox(db, 'WORKER-pass-2');

  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const csv = ['provider_ref,amount_cents,fee_cents', ...provider.statement().map((s) => `${s.provider_ref},${s.amount_cents},${s.fee_cents}`)];
  fs.writeFileSync(path.join(process.cwd(), 'data', 'provider_statement.csv'), csv.join('\n') + '\n');
  return acc;
}
