import express from 'express';
import type { PGlite } from '@electric-sql/pglite';
import { availableCents } from './ledger.js';
import { createOutboundTransfer, getTransfer } from './transfers.js';
import { handleWebhook } from './webhooks.js';
import { processOutbox } from './outbox.js';
import { reconcile } from './reconciliation.js';
import * as provider from './providers.js';
import { log } from './logger.js';
import { runTriage } from './triage.js';

type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;
// Express 4 does not catch a rejected async handler; without this a thrown error ends the process.
const wrap = (fn: Handler): express.RequestHandler => (req, res, next) => { fn(req, res).catch(next); };

export function createApp(db: PGlite) {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/accounts/:id/balance', wrap(async (req, res) => res.json({ account_id: req.params.id, available_cents: await availableCents(db, req.params.id) })));
  app.post('/transfers', wrap(async (req, res) => {
    const { account_id, rail, amount_cents, idempotency_key, scenario } = req.body ?? {};
    if (typeof account_id !== 'string' || typeof rail !== 'string' || !Number.isInteger(amount_cents) || amount_cents <= 0) {
      return res.status(400).json({ error: 'account_id (string), rail (string) and amount_cents (positive integer) are required' });
    }
    res.json(await createOutboundTransfer(db, { account_id, rail, amount_cents, idempotency_key, scenario }));
  }));
  app.get('/transfers/:id', wrap(async (req, res) => {
    const t = await getTransfer(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'transfer not found' });
    res.json(t);
  }));
  app.post('/webhooks/provider', wrap(async (req, res) => res.json(await handleWebhook(db, req.body))));
  app.post('/worker/run', wrap(async (_req, res) => { await processOutbox(db); res.json({ ok: true }); }));
  app.get('/outbox', wrap(async (_req, res) => res.json((await db.query(`select * from outbox order by id`)).rows)));
  app.get('/provider/submissions', (_req, res) => res.json(provider.submissions));
  app.get('/reconciliation', wrap(async (_req, res) => res.json(await reconcile(db))));
  app.get('/ops/triage', wrap(async (_req, res) => res.json(await runTriage(db))));
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log('api.error', { error: err.message }, '-', 'error');
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
