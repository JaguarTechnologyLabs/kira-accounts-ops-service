import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { creditInbound, createOutboundTransfer, getTransfer } from '../src/transfers.js';
import { availableCents } from '../src/ledger.js';
import { processOutbox } from '../src/outbox.js';
import * as provider from '../src/providers.js';
import { faults } from '../src/faults.js';

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

test('TICKET-203: out-of-order webhooks cannot overwrite settled status or duplicate ledger release', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Test')`);
  await creditInbound(db, { account_id: 'ACC-TEST', amount_cents: 100_000 }); // $1,000 USD initial

  console.log('\n  [TICKET-203 OUT-OF-ORDER TEST]');
  console.log(`  -> 1. Saldo disponible inicial: $${((await availableCents(db, 'ACC-TEST')) / 100).toFixed(2)}`);

  // 1. Create a payout of $750.00 with scenario 'out_of_order' (fee = 2.9% = $21.75 -> total $771.75)
  const t = await createOutboundTransfer(db, {
    account_id: 'ACC-TEST',
    rail: 'ach',
    amount_cents: 75_000,
    scenario: 'out_of_order',
  });

  const saldoConHold = (await availableCents(db, 'ACC-TEST')) / 100;
  console.log(`  -> 2. Saldo tras solicitar transferencia ($771.75 en hold): $${saldoConHold.toFixed(2)}`);
  assert.equal(await availableCents(db, 'ACC-TEST'), 22_825);

  // 2. Process outbox (provider delivers 'settled' followed by 'failed')
  console.log('  -> 3. Ejecutando worker: provider emite webhooks fuera de orden ("settled" y luego "failed")...');
  await processOutbox(db);

  // 3. Verify transfer remains in 'settled' status and is not degraded to 'failed'
  const updated = await getTransfer(db, t.id);
  console.log(`  -> 4. Estado de la transferencia en BD: "${updated.status}" (esperado: "settled")`);
  assert.equal(updated.status, 'settled', 'Settled transfer must never be overwritten by a late failed webhook');

  // 4. Verify funds were actually debited (paid to vendor) and not returned
  const saldoFinal = (await availableCents(db, 'ACC-TEST')) / 100;
  console.log(`  -> 5. Saldo disponible final: $${saldoFinal.toFixed(2)} (esperado: $228.25, sin fondos duplicados)`);
  assert.equal(await availableCents(db, 'ACC-TEST'), 22_825, 'Available balance must reflect actual debit, no duplicate release');

  // 5. Verify ledger has exactly 1 release entry
  const releases = (await db.query<any>(`select * from ledger_entries where transfer_id = $1 and entry_type = 'release'`, [t.id])).rows;
  console.log(`  -> 6. Entradas de release en ledger: ${releases.length} (esperado: 1)`);
  assert.equal(releases.length, 1, 'Hold must be released exactly once');
  console.log('  -> Resultado: PASS (Estado settled preservado y saldo exacto)');
});

test('TICKET-204: crash mid-request rolls back transfer and hold, leaving balance intact for retry', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Test')`);
  await creditInbound(db, { account_id: 'ACC-TEST', amount_cents: 100_000 }); // $1,000.00 initial

  console.log('\n  [TICKET-204 CRASH ROLLBACK TEST]');
  console.log(`  -> 1. Saldo disponible inicial: $${((await availableCents(db, 'ACC-TEST')) / 100).toFixed(2)}`);

  // 1. Simulate process crash mid-request (after hold, before outbox enqueue)
  faults.crashMidRequestFor = 'idem-204';
  let crashed = false;
  try {
    await createOutboundTransfer(db, {
      account_id: 'ACC-TEST',
      rail: 'ach',
      amount_cents: 40_000,
      idempotency_key: 'idem-204',
    });
  } catch (err: any) {
    crashed = true;
    console.log(`  -> 2. Petición falló con crash simulado: "${err.message}"`);
  } finally {
    faults.crashMidRequestFor = undefined;
  }

  assert.equal(crashed, true, 'Request must fail with simulated crash');

  // 2. Verify transfers table has 0 rows for this idempotency key
  const transfers = (await db.query<any>(`select * from transfers where idempotency_key = 'idem-204'`)).rows;
  console.log(`  -> 3. Filas en tabla transfers: ${transfers.length} (esperado: 0, revertido por rollback)`);
  assert.equal(transfers.length, 0, 'No transfer row must exist after rollback');

  // 3. Verify ledger has 0 hold entries (funds were NOT stranded)
  const holds = (await db.query<any>(`select * from ledger_entries where entry_type = 'hold'`)).rows;
  console.log(`  -> 4. Holds en ledger: ${holds.length} (esperado: 0, fondos NO varados)`);
  assert.equal(holds.length, 0, 'No holds must remain after rollback');

  // 4. Verify balance is 100% intact ($1,000.00)
  const balAfterCrash = await availableCents(db, 'ACC-TEST');
  console.log(`  -> 5. Saldo disponible tras crash: $${(balAfterCrash / 100).toFixed(2)} (esperado: $1000.00 intacto)`);
  assert.equal(balAfterCrash, 100_000, 'Available balance must remain completely untouched');

  // 5. Subsequent retry by client succeeds completely
  console.log('  -> 6. Cliente reintenta la misma transferencia con idempotency_key="idem-204"...');
  const retried = await createOutboundTransfer(db, {
    account_id: 'ACC-TEST',
    rail: 'ach',
    amount_cents: 40_000,
    idempotency_key: 'idem-204',
  });
  assert.ok(retried.id, 'Retried transfer should succeed');

  await processOutbox(db);
  const updated = await getTransfer(db, retried.id);
  console.log(`  -> 7. Transferencia completada tras reintento: status="${updated.status}"`);
  assert.equal(updated.status, 'settled', 'Retried transfer must settle successfully');
  console.log('  -> Resultado: PASS (Rollback atómico verificado y reintento exitoso)');
});

test('TICKET-205: provider timeout retry uses transfer id as idempotency key and does not pay twice', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Test')`);
  await creditInbound(db, { account_id: 'ACC-TEST', amount_cents: 200_000 }); // $2,000.00 initial

  console.log('\n  [TICKET-205 PROVIDER TIMEOUT RETRY TEST]');
  console.log(`  -> 1. Saldo inicial: $${((await availableCents(db, 'ACC-TEST')) / 100).toFixed(2)}`);

  // 1. Create transfer with scenario 'timeout_once' ($1,200.00)
  const t = await createOutboundTransfer(db, {
    account_id: 'ACC-TEST',
    rail: 'ach',
    amount_cents: 120_000,
    idempotency_key: 'idem-205',
    scenario: 'timeout_once',
  });

  // 2. Pass 1: worker attempts submission, provider accepts it but times out
  console.log('  -> 2. Ejecutando Pase 1 del worker (simula timeout del proveedor)...');
  await processOutbox(db, 'PASS-1');

  // Verify transfer is not yet marked settled and outbox is still pending for retry
  const tAfterPass1 = await getTransfer(db, t.id);
  const outboxAfterPass1 = (await db.query<any>(`select * from outbox where transfer_id = $1`, [t.id])).rows[0];
  console.log(`  -> 3. Estado tras Pase 1: transfer.status="${tAfterPass1.status}", outbox.attempts=${outboxAfterPass1.attempts}, outbox.status="${outboxAfterPass1.status}"`);
  assert.equal(outboxAfterPass1.status, 'pending', 'Outbox task must remain pending after timeout');
  assert.equal(outboxAfterPass1.attempts, 1, 'Outbox attempts must be incremented to 1');

  // 3. Pass 2: worker retries the pending event
  console.log('  -> 4. Ejecutando Pase 2 del worker (reintento seguro con idempotency_key)...');
  await processOutbox(db, 'PASS-2');

  // 4. Verify provider accepted this transfer EXACTLY ONCE (no double payout!)
  const providerSubmissions = provider.submissions.filter((s) => s.transfer_id === t.id);
  console.log(`  -> 5. Pagos aceptados por el proveedor en su extracto: ${providerSubmissions.length} (esperado: 1, sin duplicados)`);
  assert.equal(providerSubmissions.length, 1, 'Provider must accept the transfer exactly once despite timeout retry');

  // 5. Verify transfer is settled and outbox is processed
  const tFinal = await getTransfer(db, t.id);
  const outboxFinal = (await db.query<any>(`select * from outbox where transfer_id = $1`, [t.id])).rows[0];
  console.log(`  -> 6. Estado final: transfer.status="${tFinal.status}", outbox.status="${outboxFinal.status}"`);
  assert.equal(tFinal.status, 'settled', 'Transfer must reach settled status');
  assert.equal(outboxFinal.status, 'processed', 'Outbox task must be marked processed');

  // 6. Verify ledger debited amount + fee once ($1,200.00 + $34.80 = $1,234.80)
  const finalBalance = await availableCents(db, 'ACC-TEST');
  console.log(`  -> 7. Saldo final en cuenta: $${(finalBalance / 100).toFixed(2)} (cobrado exactamente 1 vez)`);
  assert.equal(finalBalance, 200_000 - (120_000 + 3_480), 'Account balance must only be debited once for amount + fee');
  console.log('  -> Resultado: PASS (Reintento de proveedor deduplicado y cero doble pago)');
});




