import type { PGlite } from '@electric-sql/pglite';
import * as provider from './providers.js';

// Compare our ledger (settled outbound transfers) against the provider's settlement statement.
export async function reconcile(db: PGlite) {
  const stmt = provider.statement();
  const byRef = new Map(stmt.map((s) => [s.provider_ref, s]));
  const rows = (await db.query<any>(`select id, provider_ref, amount_cents, fee_cents from transfers where direction='outbound' and status='settled'`)).rows;
  const seen = new Set<string>();
  let ledgerTotal = 0, statementTotal = 0;
  const feeMismatches: any[] = [];
  for (const t of rows) {
    const s = byRef.get(t.provider_ref);
    ledgerTotal += Number(t.amount_cents) + Number(t.fee_cents);
    if (s) { seen.add(t.provider_ref); statementTotal += s.amount_cents + s.fee_cents; if (s.fee_cents !== Number(t.fee_cents)) feeMismatches.push({ transfer: t.id, ledger_fee: Number(t.fee_cents), statement_fee: s.fee_cents }); }
  }
  const statementOnly = stmt.filter((s) => !seen.has(s.provider_ref)).map((s) => ({ provider_ref: s.provider_ref, amount_cents: s.amount_cents, fee_cents: s.fee_cents }));
  for (const s of statementOnly) statementTotal += s.amount_cents + s.fee_cents;
  const ledgerOnly = rows.filter((t) => !byRef.has(t.provider_ref)).map((t) => t.id);
  return { ledgerTotal, statementTotal, diffCents: statementTotal - ledgerTotal, feeMismatches, statementOnly, ledgerOnly };
}
