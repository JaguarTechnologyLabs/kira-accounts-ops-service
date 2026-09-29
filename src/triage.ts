import { PGlite } from "@electric-sql/pglite";
import * as provider from "./providers.js";
import { availableCents } from "./ledger.js";
import { reconcile } from "./reconciliation.js";

export interface Anomaly {
    id: string;
    code: 'DUPLICATE_PAYOUT' | 'LEDGER_CORRUPTION' | 'STRANDED_FUNDS' | 'STUCK_TRANSFER' | 'RECONCILIATION_DRIFT';
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    description: string;
    affectedEntities: {
    transfer_id?: string;
    account_id?: string;
    idempotency_key?: string;
    amount_cents?: number;
    provider_ref?: string;
};
    financialImpactCents: number;
    recommendedAction: string; // Runbook para el operador
}

export interface TriageReport {
    timestamp: string;
    status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    totalAnomalies: number;
    financialExposureCents: number; // Plata total en riesgo
    anomalies: Anomaly[];
    executiveSummary: string; // El resumen en lenguaje natural (LLM-drafted)
}

export async function checkDuplicatePayouts(db: PGlite): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // 1. Detectar colisiones de idempotencia en transfers (Ticket 201)
  const dupKeys = await db.query<any>(`
    SELECT idempotency_key, count(*)::int as count, max(id) as sample_id, max(account_id) as account_id, max(amount_cents)::bigint as amount_cents
    FROM transfers
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING count(*) > 1
  `);

  for (const row of dupKeys.rows) {
    const extraCharge = Number(row.amount_cents) * (row.count - 1);
    anomalies.push({
      id: `dup-idem-${row.idempotency_key}`,
      code: 'DUPLICATE_PAYOUT',
      severity: 'CRITICAL',
      title: 'Multiple transfers sharing duplicate idempotency key',
      description: `Detected ${row.count} distinct transfers sharing idempotency_key '${row.idempotency_key}'. Possible duplicate customer debit.`,
      affectedEntities: {
        idempotency_key: row.idempotency_key,
        transfer_id: row.sample_id,
        account_id: row.account_id,
        amount_cents: Number(row.amount_cents),
      },
      financialImpactCents: extraCharge,
      recommendedAction: 'Verify whether multiple payouts dispatched to provider rail; void redundant rows and release stranded holds.',
    });
  }

  // 2. Detectar pagos duplicados en el proveedor bancario (Ticket 205)
  const subCounts = new Map<string, number>();
  for (const s of provider.submissions) {
    subCounts.set(s.transfer_id, (subCounts.get(s.transfer_id) ?? 0) + 1);
  }

  for (const [transferId, count] of subCounts.entries()) {
    if (count > 1) {
      const t = (await db.query<any>(`SELECT * FROM transfers WHERE id = $1`, [transferId])).rows[0];
      const amount = Number(t?.amount_cents ?? 0);
      anomalies.push({
        id: `dup-prov-${transferId}`,
        code: 'DUPLICATE_PAYOUT',
        severity: 'CRITICAL',
        title: 'Transfer submitted multiple times to banking provider',
        description: `Transfer ${transferId} was submitted and accepted ${count} times by the payment rail. Beneficiary received duplicate funds.`,
        affectedEntities: {
          transfer_id: transferId,
          account_id: t?.account_id,
          amount_cents: amount,
          provider_ref: t?.provider_ref,
        },
        financialImpactCents: amount * (count - 1),
        recommendedAction: 'Immediately contact banking partner to initiate recall for the duplicate submission reference.',
      });
    }
  }

  return anomalies;
}

export async function checkLedgerInvariants(db: PGlite): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];
  // 1. Detectar si alguna transferencia tiene más de 1 'release' (Ticket 203)
  const dupReleases = await db.query<any>(`
    SELECT transfer_id, count(*)::int as count, max(amount_cents)::bigint as amount_cents
    FROM ledger_entries
    WHERE entry_type = 'release' AND transfer_id IS NOT NULL
    GROUP BY transfer_id
    HAVING count(*) > 1
  `);
  for (const row of dupReleases.rows) {
    const inflatedAmount = Number(row.amount_cents) * (row.count - 1);
    anomalies.push({
      id: `ledger-dup-release-${row.transfer_id}`,
      code: 'LEDGER_CORRUPTION',
      severity: 'CRITICAL',
      title: 'Multiple ledger releases for single transfer (Double Release)',
      description: `Transfer ${row.transfer_id} has ${row.count} release entries. Customer available balance is artificially inflated by $${(inflatedAmount / 100).toFixed(2)}.`,
      affectedEntities: {
        transfer_id: row.transfer_id,
        amount_cents: Number(row.amount_cents),
      },
      financialImpactCents: inflatedAmount,
      recommendedAction: 'Post corrective ledger debit to reverse unearned release before funds are withdrawn.',
    });
  }
  // 2. Detectar si alguna transferencia tiene más de 1 'debit'
  const dupDebits = await db.query<any>(`
    SELECT transfer_id, count(*)::int as count, max(amount_cents)::bigint as amount_cents
    FROM ledger_entries
    WHERE entry_type = 'debit' AND transfer_id IS NOT NULL
    GROUP BY transfer_id
    HAVING count(*) > 1
  `);
  for (const row of dupDebits.rows) {
    const overdebited = Number(row.amount_cents) * (row.count - 1);
    anomalies.push({
      id: `ledger-dup-debit-${row.transfer_id}`,
      code: 'LEDGER_CORRUPTION',
      severity: 'CRITICAL',
      title: 'Multiple debit entries for single transfer',
      description: `Transfer ${row.transfer_id} has ${row.count} debit entries in ledger. Customer was overdebited.`,
      affectedEntities: {
        transfer_id: row.transfer_id,
        amount_cents: Number(row.amount_cents),
      },
      financialImpactCents: overdebited,
      recommendedAction: 'Post corrective ledger credit entry to reimburse overdebited amount.',
    });
  }
  // 3. Detectar si alguna cuenta cayó en saldo negativo (sobregiro involuntario)
  const accounts = (await db.query<any>(`SELECT id, name FROM accounts`)).rows;
  for (const acc of accounts) {
    const bal = await availableCents(db, acc.id);
    if (bal < 0) {
      anomalies.push({
        id: `ledger-negative-balance-${acc.id}`,
        code: 'LEDGER_CORRUPTION',
        severity: 'CRITICAL',
        title: 'Account has negative available balance (Overdraft)',
        description: `Account ${acc.name} (${acc.id}) has a negative available balance of $${(bal / 100).toFixed(2)}. Involuntary overdraft exposure.`,
        affectedEntities: {
          account_id: acc.id,
          amount_cents: Math.abs(bal),
        },
        financialImpactCents: Math.abs(bal),
        recommendedAction: 'Temporarily suspend outbound transfers on account and request immediate funding from customer.',
      });
    }
  }
  return anomalies;
}

export async function checkStrandedFunds(db: PGlite): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // Detectar transferencias en estado terminal ('reversed', 'failed', 'returned') con 'hold' pero sin 'release' (Ticket 202)
  const stranded = await db.query<any>(`
    SELECT 
      t.id, 
      t.account_id, 
      t.amount_cents, 
      t.fee_cents, 
      t.status, 
      t.idempotency_key
    FROM transfers t
    WHERE t.status IN ('reversed', 'failed', 'returned')
      AND EXISTS (
        SELECT 1 FROM ledger_entries le 
        WHERE le.transfer_id = t.id AND le.entry_type = 'hold'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le 
        WHERE le.transfer_id = t.id AND le.entry_type = 'release'
      )
  `);

  for (const row of stranded.rows) {
    const totalHeld = Number(row.amount_cents) + Number(row.fee_cents);
    anomalies.push({
      id: `stranded-hold-${row.id}`,
      code: 'STRANDED_FUNDS',
      severity: 'HIGH',
      title: 'Stranded hold on terminal failed or reversed transfer',
      description: `Transfer ${row.id} reached terminal state '${row.status}', but its funds ($${(totalHeld / 100).toFixed(2)}) remain locked in ledger hold without release.`,
      affectedEntities: {
        transfer_id: row.id,
        account_id: row.account_id,
        idempotency_key: row.idempotency_key,
        amount_cents: totalHeld,
      },
      financialImpactCents: totalHeld,
      recommendedAction: `Post immediate release entry in ledger_entries for ${totalHeld} cents to return available balance to customer.`,
    });
  }

  return anomalies;
}

export async function checkStuckTransfers(db: PGlite): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // 1. Detectar transferencias en 'created' sin ninguna tarea en la tabla outbox (Ticket 204)
  const orphaned = await db.query<any>(`
    SELECT t.id, t.account_id, t.amount_cents, t.fee_cents, t.status, t.idempotency_key
    FROM transfers t
    WHERE t.status = 'created'
      AND NOT EXISTS (
        SELECT 1 FROM outbox o WHERE o.transfer_id = t.id
      )
  `);

  for (const row of orphaned.rows) {
    const total = Number(row.amount_cents) + Number(row.fee_cents);
    anomalies.push({
      id: `stuck-orphaned-${row.id}`,
      code: 'STUCK_TRANSFER',
      severity: 'HIGH',
      title: 'Orphaned transfer in created status without outbox event',
      description: `Transfer ${row.id} was created but lacks an outbox task (server crash post-creation). Funds remain held but transfer will never be dispatched.`,
      affectedEntities: {
        transfer_id: row.id,
        account_id: row.account_id,
        idempotency_key: row.idempotency_key,
        amount_cents: total,
      },
      financialImpactCents: total,
      recommendedAction: 'Retry transfer or insert missing transfer.submit task into outbox queue.',
    });
  }

  // 2. Detectar tareas de outbox que hayan agotado 3 o más reintentos
  const deadLetter = await db.query<any>(`
    SELECT o.id as outbox_id, o.transfer_id, o.attempts, o.last_error, t.account_id, t.amount_cents
    FROM outbox o
    LEFT JOIN transfers t ON t.id = o.transfer_id
    WHERE o.attempts >= 3 AND o.status != 'processed'
  `);

  for (const row of deadLetter.rows) {
    const amount = Number(row.amount_cents ?? 0);
    anomalies.push({
      id: `stuck-deadletter-${row.outbox_id}`,
      code: 'STUCK_TRANSFER',
      severity: 'HIGH',
      title: 'Outbox event exceeded maximum retry attempts (Dead-Letter)',
      description: `Task ${row.outbox_id} for transfer ${row.transfer_id} failed ${row.attempts} times. Last error: '${row.last_error ?? 'unknown'}'.`,
      affectedEntities: {
        transfer_id: row.transfer_id,
        account_id: row.account_id,
        amount_cents: amount,
      },
      financialImpactCents: amount,
      recommendedAction: 'Inspect provider connectivity and reset retry count once root cause is mitigated.',
    });
  }

  return anomalies;
}

export async function checkReconciliationDrift(db: PGlite): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];
  const r = await reconcile(db);
  // 1. Diferencia neta en conciliación general (diffCents !== 0)
  if (r.diffCents !== 0) {
    anomalies.push({
      id: 'recon-drift-diff',
      code: 'RECONCILIATION_DRIFT',
      severity: 'HIGH',
      title: 'Net reconciliation variance detected',
      description: `Internal ledger ($${(r.ledgerTotal / 100).toFixed(2)}) and provider statement ($${(r.statementTotal / 100).toFixed(2)}) differ by $${(Math.abs(r.diffCents) / 100).toFixed(2)}.`,
      affectedEntities: {
        amount_cents: Math.abs(r.diffCents),
      },
      financialImpactCents: Math.abs(r.diffCents),
      recommendedAction: 'Audit daily settlement entries to balance variance before accounting cutoff.',
    });
  }
  // 2. Discrepancias en cálculo de comisiones (Ticket 206)
  if (r.feeMismatches.length > 0) {
    const feeDiffTotal = r.feeMismatches.reduce((acc, m) => acc + Math.abs(m.statement_fee - m.ledger_fee), 0);
    anomalies.push({
      id: 'recon-drift-fees',
      code: 'RECONCILIATION_DRIFT',
      severity: 'MEDIUM',
      title: 'Fee calculation mismatch against provider statement',
      description: `Detected ${r.feeMismatches.length} transfers with fee calculations differing from provider statement.`,
      affectedEntities: {
        transfer_id: r.feeMismatches.map((m: any) => m.transfer).join(', '),
      },
      financialImpactCents: feeDiffTotal,
      recommendedAction: 'Align fee rounding logic in money.ts with provider statement specification.',
    });
  }
  // 3. Pagos presentes en el banco pero ausentes en nuestro ledger
  for (const s of r.statementOnly) {
    const total = s.amount_cents + s.fee_cents;
    anomalies.push({
      id: `recon-statement-only-${s.provider_ref}`,
      code: 'RECONCILIATION_DRIFT',
      severity: 'HIGH',
      title: 'Unmatched transaction on provider statement (missing in ledger)',
      description: `Provider statement reports transaction ${s.provider_ref} for $${(total / 100).toFixed(2)}, but no corresponding transfer exists in Kira ledger.`,
      affectedEntities: {
        provider_ref: s.provider_ref,
        amount_cents: total,
      },
      financialImpactCents: total,
      recommendedAction: 'Investigate logs for non-idempotent timeout retries or manual provider deductions.',
    });
  }
  return anomalies;
}

export async function runTriage(db: PGlite): Promise<TriageReport> {
  // 1. Llama a los 5 inspectores al mismo tiempo (en paralelo para máxima velocidad)
  const [dups, ledger, stranded, stuck, recon] = await Promise.all([
    checkDuplicatePayouts(db),
    checkLedgerInvariants(db),
    checkStrandedFunds(db),
    checkStuckTransfers(db),
    checkReconciliationDrift(db),
  ]);

  // 2. Une todos los hallazgos en una sola lista
  const anomalies = [...dups, ...ledger, ...stranded, ...stuck, ...recon];

  // 3. Suma el dinero total en riesgo sumando cada anomalía
  const financialExposureCents = anomalies.reduce((acc, a) => acc + a.financialImpactCents, 0);

  // 4. Determina el semáforo del sistema:
  // - Si hay aunque sea 1 anomalía CRITICAL -> el semáforo es CRITICAL 
  // - Si no hay críticas pero hay HIGH o MEDIUM -> el semáforo es WARNING 
  // - Si no hay ninguna -> el semáforo es HEALTHY 
  let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
  if (anomalies.some(a => a.severity === 'CRITICAL')) {
    status = 'CRITICAL';
  } else if (anomalies.some(a => a.severity === 'HIGH' || a.severity === 'MEDIUM')) {
    status = 'WARNING';
  }

  const totalAnomalies = anomalies.length;
  const timestamp = new Date().toISOString();

  // 5. Generar el resumen ejecutivo en lenguaje natural (LLM-drafted summary)
  const executiveSummary = generateExecutiveSummary({
    status,
    totalAnomalies,
    financialExposureCents,
    anomalies
  });

  // 6. Devolver el reporte consolidado
  return { 
    timestamp, 
    status, 
    totalAnomalies, 
    financialExposureCents, 
    anomalies, 
    executiveSummary 
  };
}

// Redacta un informe ejecutivo en Markdown (LLM-drafted summary) listo para canales de Slack o incidentes
export function generateExecutiveSummary(data: {
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  totalAnomalies: number;
  financialExposureCents: number;
  anomalies: Anomaly[];
}): string {
  // Caso 1: Si no hay anomalías, devuelve confirmación de sistema saludable
  if (data.totalAnomalies === 0) {
    return [
      `### Executive Summary: Systems Nominal`,
      `* **Overall Health:** HEALTHY (Green)`,
      `* **Active Incidents:** 0 detected across all financial invariants and payment rails.`,
      `* **Financial Exposure:** $0.00 USD.`,
      `* **Reconciliation:** All internal ledger entries align 1:1 with bank partner settlement statements.`,
      `* **Action Required:** None. Routine background monitoring active.`
    ].join('\n');
  }

  // Caso 2: Si hay anomalías, clasifica por severidad y detalla cada runbook de acción
  const criticals = data.anomalies.filter(a => a.severity === 'CRITICAL').length;
  const highs = data.anomalies.filter(a => a.severity === 'HIGH').length;
  const mediums = data.anomalies.filter(a => a.severity === 'MEDIUM').length;

  const summaryLines = [
    `### Executive Triage Summary: Operational Anomalies Detected`,
    `* **Overall System Health:** ${data.status} (${criticals > 0 ? 'Urgent Incident Response Required' : 'Operational Warning'})`,
    `* **Active Anomalies:** ${data.totalAnomalies} total (${criticals} Critical, ${highs} High, ${mediums} Medium)`,
    `* **Estimated Financial Exposure:** $${(data.financialExposureCents / 100).toFixed(2)} USD`,
    ``,
    `#### Key Incident Drivers & Playbook Actions:`,
    ...data.anomalies.map((a, i) => 
      `${i + 1}. **[${a.severity}] ${a.title}**\n` +
      `   * *Impact:* ${a.description}\n` +
      `   * *Risk:* $${(a.financialImpactCents / 100).toFixed(2)} USD\n` +
      `   * *Ops Runbook:* ${a.recommendedAction}`
    )
  ];

  return summaryLines.join('\n');
}

// Ejecución directa desde consola: 'npm run triage' o 'tsx src/triage.ts'
const isDirectRun = process.argv[1] && (process.argv[1].endsWith('triage.ts') || process.argv[1].endsWith('triage.js'));
if (isDirectRun) {
  // 1. Cargar dependencias de BD y poblar datos semilla en memoria
  const { openDb } = await import('./db.js');
  const { seedInto } = await import('./bootstrap.js');
  const db = await openDb();
  await seedInto(db);

  // 2. Ejecutar el diagnóstico y mostrar el tablero en pantalla
  console.log('\n=============================================================');
  console.log('       KIRA ACCOUNTS OPS SERVICE — TRIAGE MONITOR');
  console.log('=============================================================\n');

  const report = await runTriage(db);
  console.log(`Status: ${report.status === 'HEALTHY' ? '🟢 HEALTHY' : report.status === 'WARNING' ? '🟡 WARNING' : '🔴 CRITICAL'}`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Total Anomalies: ${report.totalAnomalies}`);
  console.log(`Financial Exposure: $${(report.financialExposureCents / 100).toFixed(2)} USD\n`);

  // 3. Imprimir el resumen ejecutivo y cerrar la conexión de base de datos
  console.log(report.executiveSummary);
  console.log('\n=============================================================\n');

  await db.close();
}