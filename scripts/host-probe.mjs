import { subscribe } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.HIVEMEM_ACCEPT_DIR;
const seen = new Set();
function mark(name) {
  if (!dir || seen.has(name)) return;
  try {
    writeFileSync(join(dir, name), '', { flag: 'wx', mode: 0o600 });
    seen.add(name);
  } catch { /* Missing evidence must not interrupt the server. */ }
}
mark('server-launched');
subscribe('hivemem.mcp.setup-reply', method => {
  if (method === 'initialize' || method === 'server/discover') mark('protocol-replied');
  if (method === 'tools/list') mark('tools-listed');
});
