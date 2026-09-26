import { openDb } from './db.js';
import { seedInto } from './bootstrap.js';
import { processOutbox } from './outbox.js';
import { createApp } from './app.js';

const db = await openDb();
await seedInto(db);
const app = createApp(db);
setInterval(() => processOutbox(db).catch(() => {}), 2000);
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`kira-accounts-ops-service on :${port} (seeded, in-memory; worker every 2s)`));
