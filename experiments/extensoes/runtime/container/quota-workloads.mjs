// Programas sintéticos fixos. Cada recusa exige causa específica e controle positivo.
export const QUOTA_SOURCES = Object.freeze({
  quota_fs: String.raw`
const fs = require('node:fs');
const assert = require('node:assert/strict');
fs.writeFileSync('/tmp/extbench-positive.txt', 'synthetic');
assert.equal(fs.readFileSync('/tmp/extbench-positive.txt', 'utf8'), 'synthetic');
fs.unlinkSync('/tmp/extbench-positive.txt');
assert.ok(fs.statSync('/var/tmp').isDirectory());
let failure;
try { fs.writeFileSync('/var/tmp/extbench-rootfs.txt', 'synthetic'); }
catch (error) { failure = error.code; }
assert.equal(failure, 'EROFS');
process.stdout.write(JSON.stringify({ positive_tmp:true, rootfs_error:failure }) + '\n');
`,
  quota_network: String.raw`
const net = require('node:net');
const assert = require('node:assert/strict');
(async () => {
  const server = net.createServer(socket => socket.end('synthetic'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let received = '';
  await new Promise((resolve, reject) => {
    const client = net.connect({host:'127.0.0.1', port:server.address().port});
    client.on('data', chunk => { received += chunk.toString(); });
    client.once('end', resolve); client.once('error', reject);
    client.setTimeout(1000, () => client.destroy(new Error('loopback_timeout')));
  });
  await new Promise(resolve => server.close(resolve));
  assert.equal(received, 'synthetic');
  const failure = await new Promise((resolve, reject) => {
    // TEST-NET-1, sem DNS ou destinatário real; network none deve recusar pela rota.
    const client = net.connect({host:'192.0.2.1', port:443});
    client.once('connect', () => { client.destroy(); reject(new Error('unexpected_external_connection')); });
    client.once('error', error => resolve(error.code));
    client.setTimeout(500, () => client.destroy(new Error('external_timeout')));
  });
  assert.ok(['ENETUNREACH', 'EHOSTUNREACH'].includes(failure), String(failure));
  process.stdout.write(JSON.stringify({ loopback_allowed:true, external_error:failure }) + '\n');
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
`,
  quota_memory: String.raw`
const fs = require('node:fs');
const assert = require('node:assert/strict');
const memoryMax = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());
assert.equal(memoryMax, 134217728);
process.stdout.write(JSON.stringify({ stage:'external_buffer_fill', memory_max:memoryMax }) + '\n');
const retained = [];
for (let index = 0; index < 16; index++) retained.push(Buffer.alloc(16 * 1024 * 1024, 0x5a));
throw new Error('memory_limit_not_enforced');
`,
  quota_pids: String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const maximum = Number(fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim());
  assert.equal(maximum, 32);
  const children = [];
  let failure, atFailure;
  try {
    for (let index = 0; index < maximum + 2; index++) {
      const child = spawn('/bin/sleep', ['30'], {stdio:'ignore'});
      const closed = new Promise(resolve => child.once('close', resolve));
      const result = await new Promise(resolve => {
        child.once('spawn', () => resolve('spawned'));
        child.once('error', error => resolve(error.code));
      });
      if (result !== 'spawned') {
        failure = result;
        atFailure = Number(fs.readFileSync('/sys/fs/cgroup/pids.current', 'utf8').trim());
        await closed;
        break;
      }
      children.push({child, closed});
    }
    assert.ok(children.length > 0, 'no_positive_spawn');
    assert.equal(failure, 'EAGAIN');
    assert.equal(atFailure, maximum);
  } finally {
    for (const {child} of children) child.kill('SIGKILL');
    await Promise.all(children.map(({closed}) => closed));
  }
  process.stdout.write(JSON.stringify({ positive_spawns:children.length, error:failure,
    pids_max:maximum, pids_current_at_failure:atFailure,
    pids_current_after_cleanup:Number(fs.readFileSync('/sys/fs/cgroup/pids.current', 'utf8').trim()) }) + '\n');
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
`,
  quota_output: String.raw`process.stdout.write('X'.repeat(65537) + '\n');`,
});
