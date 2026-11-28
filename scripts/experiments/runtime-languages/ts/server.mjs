// Experiment-only transport. The runner copies the real parser into model.ts.
import { createServer } from 'node:net';
import { chmodSync } from 'node:fs';
import { parseCodexModelCatalog } from './model.ts';
import { PROTOCOL } from './contract.ts';

const server = createServer(socket => {
  socket.setEncoding('utf8');
  let pending = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1024 * 1024) return socket.destroy();
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let value;
      try { value = JSON.parse(line); }
      catch { socket.write(JSON.stringify({ protocol: PROTOCOL, error: 'invalid_json' }) + '\n'); continue; }
      try {
        socket.write(JSON.stringify({ protocol: PROTOCOL, catalog: parseCodexModelCatalog(value, 123) }) + '\n');
      } catch {
        socket.write(JSON.stringify({ protocol: PROTOCOL, error: 'empty_catalog' }) + '\n');
      }
    }
  });
});
server.listen(process.argv[2], () => { chmodSync(process.argv[2], 0o600); console.log('ready'); });
