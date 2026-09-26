import fs from 'fs';
import path from 'path';
// Under the Node test runner (it sets NODE_TEST_CONTEXT) lines go to logs/test.ndjson, so a test
// run never mixes into the incident log the tickets point at.
const LOG = path.join(process.cwd(), 'logs', process.env.NODE_TEST_CONTEXT ? 'test.ndjson' : 'incidents.ndjson');
export function resetLog() { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, ''); } catch {} }
export function log(event: string, ctx: Record<string, unknown> = {}, correlationId = '-', level: 'info' | 'warn' | 'error' = 'info') {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'accounts-ops', event, correlation_id: correlationId, ...ctx });
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch {}
  return line;
}
