import { openDb } from './db.js';
import { seedInto } from './bootstrap.js';
const db = await openDb();
await seedInto(db);
console.log('Seed complete. Logs -> ./logs/incidents.ndjson ; provider statement -> ./data/provider_statement.csv');
console.log('Run `npm run demo` to see the symptoms, or `npm run dev` for the API.');
await db.close();
