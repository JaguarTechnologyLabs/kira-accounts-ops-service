import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { creditInbound, createOutboundTransfer } from '../src/transfers.js';
import * as provider from '../src/providers.js';

test('TICKET-201: concurrent requests with the same idempotency key return the same transfer and do not duplicate', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Test')`);
  await creditInbound(db, { account_id: 'ACC-TEST', amount_cents: 200_000 });

  // Two identical requests fired concurrently with the same idempotency key
  const [t1, t2] = await Promise.all([
    createOutboundTransfer(db, { account_id: 'ACC-TEST', rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201' }),
    createOutboundTransfer(db, { account_id: 'ACC-TEST', rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201' }),
  ]);

  // Both callers must receive the exact same transfer
  assert.equal(t1.id, t2.id, 'Both concurrent requests must resolve to the exact same transfer id');

  // The database must only contain one transfer record for this idempotency key
  const transfers = (await db.query<any>(`select * from transfers where idempotency_key = 'idem-201'`)).rows;
  assert.equal(transfers.length, 1, 'Only one transfer must be inserted in the database');

  // The ledger must only hold funds once
  const holds = (await db.query<any>(`select * from ledger_entries where entry_type = 'hold'`)).rows;
  assert.equal(holds.length, 1, 'Only one hold entry must be recorded in the ledger');
});
