import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { availableCents } from '../src/ledger.js';
import { creditInbound, createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import { handleWebhook } from '../src/webhooks.js';
import * as provider from '../src/providers.js';

async function fresh() { provider.resetProvider(); const db = await openDb(); await db.query(`insert into accounts(id,name) values ('A','Test')`); await creditInbound(db, { account_id: 'A', amount_cents: 100_000 }); return db; }

test('inbound credit increases available balance', async () => {
  const db = await fresh();
  assert.equal(await availableCents(db, 'A'), 100_000);
});

test('a retried request with the same idempotency key does not create a second transfer', async () => {
  const db = await fresh();
  const a = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k1' });
  const b = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k1' });
  assert.equal(a.id, b.id);
});

test('an outbound payout settles through the worker and debits amount + fee', async () => {
  const db = await fresh();
  await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k2' });
  await processOutbox(db);
  assert.equal(await availableCents(db, 'A'), 89_710); // fee = 290
});

test('a duplicate provider webhook (same event id) is ignored', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k3' });
  await processOutbox(db);
  const ref = (await db.query<any>(`select provider_ref from transfers where id=$1`, [t.id])).rows[0].provider_ref;
  await handleWebhook(db, { provider_event_id: 'dup-1', provider_ref: ref, status: 'settled' });
  await handleWebhook(db, { provider_event_id: 'dup-1', provider_ref: ref, status: 'settled' });
  assert.equal(await availableCents(db, 'A'), 89_710); // balance unchanged by the duplicate
});
