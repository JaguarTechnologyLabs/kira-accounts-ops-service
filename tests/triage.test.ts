import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import * as provider from '../src/providers.js';
import { 
  runTriage, 
  checkDuplicatePayouts, 
  checkLedgerInvariants, 
  checkStrandedFunds, 
  checkStuckTransfers 
} from '../src/triage.js';

test('TRIAGE: healthy system returns zero anomalies and status HEALTHY', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Healthy Client')`);

  const report = await runTriage(db);
  assert.equal(report.status, 'HEALTHY');
  assert.equal(report.totalAnomalies, 0);
  assert.equal(report.financialExposureCents, 0);
  assert.match(report.executiveSummary, /Systems Nominal/);

  await db.close();
});

test('TRIAGE: detects stranded hold in reversed transfer without release', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Stranded Test')`);
  
  // Create transfer stuck in reversed with hold but no release
  await db.query(`
    insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key)
    values ('TX-STRANDED', 'ACC-TEST', 'outbound', 'ach', 50000, 1450, 'reversed', 'idem-stranded')
  `);
  await db.query(`
    insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
    values ('TX-STRANDED', 'ACC-TEST', 'hold', 51450, 'hold test')
  `);

  const anomalies = await checkStrandedFunds(db);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].code, 'STRANDED_FUNDS');
  assert.equal(anomalies[0].severity, 'HIGH');
  assert.equal(anomalies[0].financialImpactCents, 51450);
  assert.equal(anomalies[0].affectedEntities.transfer_id, 'TX-STRANDED');

  await db.close();
});

test('TRIAGE: detects double release violating ledger invariants', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Double Release Test')`);

  // Insert two releases for the same transfer
  await db.query(`
    insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
    values ('TX-INFLATED', 'ACC-TEST', 'release', 75000, 'first release'),
           ('TX-INFLATED', 'ACC-TEST', 'release', 75000, 'second duplicate release')
  `);

  const anomalies = await checkLedgerInvariants(db);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].code, 'LEDGER_CORRUPTION');
  assert.equal(anomalies[0].severity, 'CRITICAL');
  assert.equal(anomalies[0].financialImpactCents, 75000);
  assert.equal(anomalies[0].affectedEntities.transfer_id, 'TX-INFLATED');

  await db.close();
});

test('TRIAGE: detects orphaned created transfer without outbox task', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'Orphan Test')`);

  // Insert created transfer but zero outbox entries
  await db.query(`
    insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key)
    values ('TX-ORPHAN', 'ACC-TEST', 'outbound', 'ach', 40000, 1160, 'created', 'idem-orphan')
  `);

  const anomalies = await checkStuckTransfers(db);
  const orphanAnomaly = anomalies.find(a => a.id === 'stuck-orphaned-TX-ORPHAN');
  assert.ok(orphanAnomaly);
  assert.equal(orphanAnomaly.code, 'STUCK_TRANSFER');
  assert.equal(orphanAnomaly.severity, 'HIGH');
  assert.equal(orphanAnomaly.financialImpactCents, 41160);

  await db.close();
});

test('TRIAGE: GET /ops/triage returns 200 and structured triage report JSON', async () => {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id, name) values ('ACC-TEST', 'HTTP Test')`);

  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const res = await fetch(`${base}/ops/triage`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.status, 'HEALTHY');
  assert.equal(data.totalAnomalies, 0);
  assert.equal(typeof data.executiveSummary, 'string');
  assert.ok(Array.isArray(data.anomalies));

  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});
