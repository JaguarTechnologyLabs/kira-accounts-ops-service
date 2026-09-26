import type { PGlite } from '@electric-sql/pglite';
type Q = { query: PGlite['query'] };

export async function post(db: Q, e: { transfer_id?: string; account_id: string; entry_type: string; amount_cents: number; memo?: string }) {
  await db.query(
    `insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo) values ($1,$2,$3,$4,$5)`,
    [e.transfer_id ?? null, e.account_id, e.entry_type, e.amount_cents, e.memo ?? null]
  );
}

// Available balance is DERIVED from the ledger: credit/release add, debit/hold remove.
export async function availableCents(db: Q, account_id: string): Promise<number> {
  const r = await db.query<{ bal: string }>(
    `select coalesce(sum(case entry_type
        when 'credit' then amount_cents when 'release' then amount_cents
        when 'debit' then -amount_cents when 'hold' then -amount_cents else 0 end), 0)::bigint as bal
     from ledger_entries where account_id = $1`, [account_id]);
  return Number(r.rows[0].bal);
}
