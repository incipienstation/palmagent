import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { renderNginx } from '../../skills/.shared/render-nginx.mjs';

const config = {
  instanceId: 'abcdef123456', domain: 'agent.example.com', host: '::1', port: 4123,
  certificate: '/var/lib/palmagent-ingress/tls/fullchain.pem',
  privateKey: '/var/lib/palmagent-ingress/tls/privkey.pem', acmeRoot: '/var/lib/palmagent-ingress/acme',
};

test('plugin renderer keeps challenges reachable and application traffic HTTPS-only', () => {
  const result = renderNginx(config);
  assert(!result.bootstrap.text.includes('proxy_pass'));
  assert(!result.bootstrap.text.includes('listen 443'));
  assert(result.bootstrap.text.includes('return 404;'));
  const http = result.vhost.text.split('server {')[1];
  assert(!http.includes('proxy_pass'));
  for (const site of [http, result.bootstrap.text]) assert(site.includes(`location ^~ /.well-known/acme-challenge/ { root ${config.acmeRoot}; }`));
  assert(http.includes(`return 308 https://${config.domain}$request_uri`));
  const upstreams = [...result.vhost.text.matchAll(/proxy_pass ([^;]+);/g)].map(m => m[1]);
  assert(upstreams.length > 0);
  assert(upstreams.every(url => url === 'http://[::1]:4123'));
  assert(result.vhost.text.includes(`ssl_certificate ${config.certificate};`));
  assert(result.vhost.text.includes('proxy_buffering off;'));
  assert(result.vhost.text.includes('proxy_set_header Upgrade $http_upgrade;'));
  assert(result.vhost.text.includes('proxy_read_timeout 3600s;'));
  assert(result.vhost.text.includes('Strict-Transport-Security'));
  assert(!result.vhost.text.includes('$proxy_add_x_forwarded_for'));
});

test('separate installations have distinct files, rate zones and TLS caches', () => {
  const first = renderNginx(config), second = renderNginx({ ...config, instanceId: '123456abcdef' });
  for (const kind of ['vhost', 'bootstrap', 'zones']) assert.notEqual(first[kind].name, second[kind].name);
  for (const token of ['_api', '_auth', '_conn', '_ssl']) {
    assert((first.vhost.text + first.zones.text).includes(config.instanceId + token));
    assert(!(second.vhost.text + second.zones.text).includes(config.instanceId + token));
  }
});

test('untrusted renderer input cannot inject nginx directives or non-local upstreams', () => {
  for (const change of [
    { domain: 'a.example.com; include /tmp/evil' }, { instanceId: 'a;evil' },
    { host: Array(4).fill('0').join('.') }, { port: 0 }, { port: '4100; evil' },
    { certificate: '/tmp/a\ninclude' }, { privateKey: '/tmp/../key' }, { acmeRoot: '/tmp/$var' },
  ]) assert.throws(() => renderNginx({ ...config, ...change }));
});

test('standalone plugin helper emits JSON candidates without host side effects', () => {
  const result = spawnSync(process.execPath, [new URL('../../skills/.shared/render-nginx.mjs', import.meta.url).pathname], { input: JSON.stringify(config), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), renderNginx(config));
});

test('rendered nginx configuration coexists with another TLS cache and installation', async t => {
  if (spawnSync('nginx', ['-v']).error || spawnSync('openssl', ['version']).error) {
    t.skip('nginx and openssl are required for syntax integration'); return;
  }
  const root = mkdtempSync(join(tmpdir(), 'palmagent-nginx-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certificate = join(root, 'cert.pem'), privateKey = join(root, 'key.pem');
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=agent.example.com', '-keyout', privateKey, '-out', certificate], { encoding: 'utf8' });
  assert.equal(cert.status, 0, cert.stderr);
  const first = renderNginx({ ...config, certificate, privateKey, acmeRoot: root });
  const second = renderNginx({ ...config, instanceId: '123456abcdef', domain: 'second.example.com', certificate, privateKey, acmeRoot: root });
  const ports = [];
  const reservations = [];
  for (let i = 0; i < 3; i++) {
    const server = createServer();
    await new Promise(resolve => server.listen(0, ['127', '0', '0', '1'].join('.'), resolve));
    reservations.push(server); ports.push(server.address().port);
  }
  await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  const prefix = `error_log stderr; pid ${root}/nginx.pid; events {} http { access_log off; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy; fastcgi_temp_path ${root}/fastcgi; uwsgi_temp_path ${root}/uwsgi; scgi_temp_path ${root}/scgi;`;
  const existing = `server { listen ${ports[2]} ssl; server_name existing.example.com; ssl_certificate ${certificate}; ssl_certificate_key ${privateKey}; ssl_session_cache shared:SSL:1m; }`;
  for (const phase of ['bootstrap', 'vhost']) {
    const file = join(root, 'nginx.conf');
    // Syntax-test on unprivileged temporary ports; never touch the host's listeners.
    const candidate = (prefix + existing + first.zones.text + second.zones.text + first[phase].text + second[phase].text + '}')
      .replace(/listen (\[::\]:)?80;/g, `listen $1${ports[0]};`)
      .replace(/listen (\[::\]:)?443 ssl;/g, `listen $1${ports[1]} ssl;`);
    writeFileSync(file, candidate);
    const result = spawnSync('nginx', ['-t', '-p', root, '-c', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert(!result.stderr.includes('conflicting server name'), result.stderr);
  }
});
