import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { creditInbound, createOutboundTransfer, getTransfer } from '../src/transfers.js';
import { availableCents } from '../src/ledger.js';
import { processOutbox } from '../src/outbox.js';
import * as provider from '../src/providers.js';

test('TICKET-201: concurrent requests with the same idempotency key return the same transfer and do not duplicate', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Test')`);
  await creditInbound(db, { account_id: 'ACC-TEST', amount_cents: 200_000 });

  console.log('\n  [TICKET-201 CONCURRENCY TEST]');
  console.log('  -> Disparando 2 peticiones en paralelo con idempotency_key="idem-201"...');

  // Two identical requests fired concurrently with the same idempotency key
  const [t1, t2] = await Promise.all([
    createOutboundTransfer(db, { account_id: 'ACC-TEST', rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201' }),
    createOutboundTransfer(db, { account_id: 'ACC-TEST', rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201' }),
  ]);

  console.log(`  -> Respuesta Petición 1: id=${t1.id}`);
  console.log(`  -> Respuesta Petición 2: id=${t2.id}`);

  // Both callers must receive the exact same transfer
  assert.equal(t1.id, t2.id, 'Both concurrent requests must resolve to the exact same transfer id');

  // The database must only contain one transfer record for this idempotency key
  const transfers = (await db.query<any>(`select * from transfers where idempotency_key = 'idem-201'`)).rows;
  console.log(`  -> Filas en tabla transfers: ${transfers.length} (esperado: 1)`);
  assert.equal(transfers.length, 1, 'Only one transfer must be inserted in the database');

  // The ledger must only hold funds once
  const holds = (await db.query<any>(`select * from ledger_entries where entry_type = 'hold'`)).rows;
  console.log(`  -> Entradas de hold en ledger: ${holds.length} (esperado: 1)`);
  assert.equal(holds.length, 1, 'Only one hold entry must be recorded in the ledger');
  console.log('  -> Resultado: PASS (Cero duplicados en concurrencia)');
});

test('TICKET-202: reversed payout reaches terminal status and releases held funds', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Test')`);
  await creditInbound(db, { account_id: 'ACC-TEST', amount_cents: 100_000 });

  console.log('\n  [TICKET-202 REVERSAL TEST]');
  console.log(`  -> 1. Saldo disponible inicial: $${((await availableCents(db, 'ACC-TEST')) / 100).toFixed(2)}`);

  // 1. Create a crypto payout with scenario 'reversed' ($600 + $17.40 fee)
  const t = await createOutboundTransfer(db, {
    account_id: 'ACC-TEST',
    rail: 'crypto',
    amount_cents: 60_000,
    scenario: 'reversed',
  });

  const saldoConHold = (await availableCents(db, 'ACC-TEST')) / 100;
  console.log(`  -> 2. Saldo tras solicitar transferencia ($617.40 en hold): $${saldoConHold.toFixed(2)}`);
  assert.equal(await availableCents(db, 'ACC-TEST'), 38_260);

  // 2. Process outbox (submits to provider and receives 'reversed' webhook)
  console.log('  -> 3. Ejecutando worker: provider procesa y emite webhook con status="reversed"...');
  await processOutbox(db);

  // 3. Verify transfer reached terminal 'reversed' status
  const updated = await getTransfer(db, t.id);
  console.log(`  -> 4. Estado de la transferencia en BD: "${updated.status}" (esperado: "reversed")`);
  assert.equal(updated.status, 'reversed', 'Transfer must transition to terminal reversed status');

  // 4. Verify funds were completely released back to available balance
  const saldoFinal = (await availableCents(db, 'ACC-TEST')) / 100;
  console.log(`  -> 5. Saldo disponible tras release: $${saldoFinal.toFixed(2)} (fondos descongelados al 100%)`);
  assert.equal(await availableCents(db, 'ACC-TEST'), 100_000, 'Available balance must be fully restored');
  console.log('  -> Resultado: PASS (Transferencia en reversed y fondos liberados)');
});

