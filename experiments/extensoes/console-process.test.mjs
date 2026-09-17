import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { childEnvironment, readContext } from './common.mjs';
import { prepareProbe, cancelProbe, ProbeBusyError, probeReservation } from './probe-supervisor.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:38761';
async function until(fn) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Condição não observada.');
}
async function fixture() {
  const owned = await readContext(root);
  const directory = await mkdtemp(path.join(owned.evidenceDir, 'console-process-'));
  const source = path.join(directory, 'experiments/extensoes');
  const evidence = path.join(directory, '.superpowers/evidence/extensoes-bancada');
  await mkdir(source, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'owner.json'), JSON.stringify({ purpose: 'extensions-architecture-bench', repo_root: directory }));
  await writeFile(path.join(evidence, 'database.json'), JSON.stringify({ database_url: 'postgresql://extensions_bench_owner@127.0.0.1:59999/extensions_bench' }));
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  for (const name of await readdir(path.join(root, 'experiments/extensoes'))) {
    if (['console.mjs', 'console.html', 'runner.mjs', 'common.mjs'].includes(name) || name.startsWith('probe-supervisor') && !name.includes('.test.')) {
      await cp(path.join(root, 'experiments/extensoes', name), path.join(source, name));
    }
  }
  for (const id of ['runtime', 'events', 'state']) {
    await mkdir(path.join(source, id));
    await writeFile(path.join(source, id, 'probe.mjs'), `
import { writeFile, access } from 'node:fs/promises';
export async function runProbe(context) {
  await writeFile(context.repoRoot + '/${id}-started.json', JSON.stringify({ pid: process.pid, root: context.repoRoot }));
  while (true) {
    try { await access(context.repoRoot + '/release'); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { id: '${id}', status: 'passed', checks: [{ id: 'controlled_real_process', passed: true }], limitations: [] };
}
`);
  }
  return { directory, source, evidence };
}
function start(directory, command = 'console.mjs', args = []) {
  const child = spawn(process.execPath, [path.join(directory, 'experiments/extensoes', command), ...args], {
    cwd: directory, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.output += data; });
  child.closed = once(child, 'close');
  return child;
}
async function ready(child) {
  await until(() => {
    if (child.exitCode !== null) throw new Error(child.output);
    return child.output.includes('http://127.0.0.1:38761');
  });
}
async function post(id) {
  return fetch(`${origin}/api/run/${id}`, { method: 'POST', headers: { origin, 'x-request-id': crypto.randomUUID() } });
}
async function started(directory, id) {
  return until(async () => {
    try { return JSON.parse(await readFile(path.join(directory, `${id}-started.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  });
}

test('SIGKILL do console preserva exclusão até o executor terminar; CLI e segundo console recusam sobreposição', async () => {
  // Não assume propriedade de qualquer serviço já escutando a porta fixa.
  await assert.rejects(fetch(`${origin}/api/status`), /fetch failed/);
  const own = await fixture();
  const children = [];
  try {
    const first = start(own.directory); children.push(first); await ready(first);
    assert.equal((await post('runtime')).status, 202);
    const worker = await started(own.directory, 'runtime');
    assert.equal(worker.root, own.directory);
    first.kill('SIGKILL'); await first.closed;
    process.kill(worker.pid, 0);
    const second = start(own.directory); children.push(second); await ready(second);
    const competitor = start(own.directory); children.push(competitor);
    assert.notEqual((await competitor.closed)[0], 0);
    assert.match(competitor.output, /EADDRINUSE/);
    assert.equal((await post('events')).status, 409);
    const cli = start(own.directory, 'runner.mjs', ['events']); children.push(cli);
    assert.equal((await cli.closed)[0], 73);
    await assert.rejects(readFile(path.join(own.directory, 'events-started.json')), { code: 'ENOENT' });
    await writeFile(path.join(own.directory, 'release'), 'finish');
    await until(async () => !(await (await fetch(`${origin}/api/status`)).json()).active);
    assert.equal((await post('events')).status, 202);
    await until(async () => (await (await fetch(`${origin}/api/status`)).json()).jobs.events?.status === 'passed');
    assert.equal((await started(own.directory, 'events')).root, own.directory);
    await writeFile(path.join(own.directory, 'assertions.json'), JSON.stringify({ console_killed: true, worker_survived: true, concurrent_http: 409, concurrent_cli: 73, resumed: 'passed' }));
  } finally {
    // Só filhos criados aqui; os probes recebem liberação cooperativa, sem PID de terceiros.
    await writeFile(path.join(own.directory, 'release'), 'cleanup');
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.closed));
  }
});

for (const cause of ['timeout', 'SIGTERM']) test(`${cause} encerra o grupo próprio e libera reserva somente após o trabalho parar`, async () => {
  const own = await fixture();
  await writeFile(path.join(own.source, 'runtime/probe.mjs'), `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
export async function runProbe(context) {
  const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); setInterval(() => fs.appendFileSync('heartbeat', 'x'), 10);"], { cwd: context.repoRoot, stdio: 'inherit' });
  await writeFile(context.repoRoot + '/runtime-started.json', JSON.stringify({ pid: process.pid, child: child.pid, root: context.repoRoot }));
  await new Promise(() => {});
}
`);
  const context = await readContext(own.directory);
  const supervisor = await prepareProbe(context, 'runtime', { timeoutMs: cause === 'timeout' ? 700 : 10000 });
  supervisor.stdout.resume(); supervisor.stderr.resume();
  try {
    supervisor.stdin.end('run\n');
    await started(own.directory, 'runtime');
    await until(async () => { try { return (await readFile(path.join(own.directory, 'heartbeat'))).length > 0; } catch { return false; } });
    assert.equal(await probeReservation(context), 'runtime');
    await assert.rejects(prepareProbe(context, 'events'), ProbeBusyError);
    if (cause === 'SIGTERM') cancelProbe(supervisor);
    assert.equal(await supervisor.closed, 1);
    const content = await readFile(path.join(own.directory, 'heartbeat'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(path.join(own.directory, 'heartbeat'), 'utf8'), content);
    assert.equal(await probeReservation(context), null);
    const next = await prepareProbe(context, 'events');
    next.stdin.end(); await next.closed;
    assert.equal((await readContext(own.directory)).evidenceDir, own.evidence);
  } finally { cancelProbe(supervisor); await supervisor.closed; }
});

test('SIGKILL do supervisor mantém recusa conservadora mesmo após o runner terminar', async () => {
  const own = await fixture();
  const context = await readContext(own.directory);
  const supervisor = await prepareProbe(context, 'runtime');
  supervisor.stdout.resume(); supervisor.stderr.resume();
  try {
    supervisor.stdin.end('run\n');
    const worker = await started(own.directory, 'runtime');
    supervisor.kill('SIGKILL');
    process.kill(worker.pid, 0);
    await assert.rejects(prepareProbe(context, 'events'), ProbeBusyError);
    await writeFile(path.join(own.directory, 'release'), 'finish');
    await supervisor.closed;
    await until(() => { try { process.kill(worker.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
    await assert.rejects(prepareProbe(context, 'events'), ProbeBusyError);
    assert.equal(await probeReservation(context), 'runtime');
    await assert.rejects(readFile(path.join(own.directory, 'events-started.json')), { code: 'ENOENT' });
  } finally { await writeFile(path.join(own.directory, 'release'), 'cleanup'); cancelProbe(supervisor); await supervisor.closed; }
});

test('reserva simbólica não abre nem modifica recurso vizinho; worker privado recusa CLI sem reserva', async () => {
  const own = await fixture();
  const sentinel = path.join(own.directory, 'sentinel');
  await writeFile(sentinel, 'preservar');
  await symlink(sentinel, path.join(own.evidence, 'probe.lock'));
  await assert.rejects(prepareProbe(await readContext(own.directory), 'runtime'));
  assert.equal(await readFile(sentinel, 'utf8'), 'preservar');
  const bypass = start(own.directory, 'probe-supervisor-worker.mjs', ['runtime']);
  assert.equal((await bypass.closed)[0], 1);
  await assert.rejects(readFile(path.join(own.directory, 'runtime-started.json')), { code: 'ENOENT' });
});

test('falha anormal do runner não libera reserva enquanto descendente independente continua', async () => {
  const own = await fixture();
  await writeFile(path.join(own.source, 'runtime/probe.mjs'), `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
export async function runProbe(context) {
  const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); setInterval(() => { if (fs.existsSync('release')) process.exit(0); fs.appendFileSync('heartbeat', 'x'); }, 10);"], { cwd: context.repoRoot, stdio: 'ignore' });
  await writeFile(context.repoRoot + '/runtime-started.json', JSON.stringify({ pid: process.pid, child: child.pid, root: context.repoRoot }));
  process.exit(7);
}
`);
  const context = await readContext(own.directory);
  const supervisor = await prepareProbe(context, 'runtime');
  supervisor.stdout.resume(); supervisor.stderr.resume();
  try {
    supervisor.stdin.end('run\n');
    assert.equal(await supervisor.closed, 1);
    const worker = await started(own.directory, 'runtime');
    process.kill(worker.child, 0);
    await assert.rejects(prepareProbe(context, 'events'), ProbeBusyError);
    assert.equal(await probeReservation(context), 'runtime');
  } finally {
    await writeFile(path.join(own.directory, 'release'), 'cleanup');
    cancelProbe(supervisor); await supervisor.closed;
  }
});
