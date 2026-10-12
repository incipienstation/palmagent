const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const data = fs.realpathSync(process.argv[2]);
const root = `/tmp/palmagentd-${process.getuid()}-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 20)}`;
fs.mkdirSync(root, { mode: 0o700 });
const socket = path.join(root, 'control.sock');
let instance = 'first';
const server = net.createServer(stream => {
  let input = '';
  stream.on('error', () => {});
  stream.on('data', chunk => {
    input += chunk;
    if (!input.includes('\n')) return;
    try {
      const { protocol, request } = JSON.parse(input);
      if (protocol !== 1) throw new Error('unsupported protocol');
      fs.appendFileSync(path.join(data, 'requests.jsonl'), JSON.stringify(request) + '\n');
      if (request.action === 'replace') instance = 'replacement-' + Date.now();
      const config = JSON.parse(fs.readFileSync(path.join(data, 'daemon/config.json'), 'utf8'));
      const build = JSON.parse(fs.readFileSync(path.join(config.release, 'build-info.json'), 'utf8'));
      const result = request.action === 'status' ? { protocol: 1, ...build, instance, pid: process.pid, isolation: 'cgroup', web: { state: 'running', alive: true } } : {};
      stream.end(JSON.stringify({ protocol: 1, ok: true, result }) + '\n');
    } catch { stream.end(JSON.stringify({ protocol: 1, ok: false, error: 'fixture error' }) + '\n'); }
  });
});
server.listen(socket, () => { fs.chmodSync(socket, 0o600); process.send('ready'); });
