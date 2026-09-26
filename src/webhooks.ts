import type { PGlite } from '@electric-sql/pglite';
import { applyProviderResult } from './transfers.js';
import { log } from './logger.js';

// Provider settlement webhook. Deliveries can be duplicated, so we de-dupe on provider_event_id.
export async function handleWebhook(db: PGlite, evt: { provider_event_id: string; provider_ref: string; status: string; correlation_id?: string }) {
  const cid = evt.correlation_id ?? '-';
  const dup = await db.query(`select 1 from processed_events where provider_event_id = $1`, [evt.provider_event_id]);
  if (dup.rows.length) { log('webhook.duplicate_skipped', { provider_event_id: evt.provider_event_id }, cid); return { status: 'skipped' }; }
  await db.query(`insert into processed_events(provider_event_id) values ($1)`, [evt.provider_event_id]);

  const t = (await db.query<any>(`select * from transfers where provider_ref = $1`, [evt.provider_ref])).rows[0];
  if (!t) { log('webhook.unknown_transfer', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, status: evt.status }, cid, 'warn'); return { status: 'unknown_transfer' }; }
  log('webhook.received', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, transfer_id: t.id, status: evt.status, current_status: t.status }, cid);
  await applyProviderResult(db, t, evt.status, cid);
  return { status: 'processed' };
}
