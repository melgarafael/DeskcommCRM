import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { childEnvironment, connectBenchDatabase, ensureOwnedWorkspace, readContext, readJsonPlain, writeJsonAtomic } from './common.mjs';
import { runHarness } from './db-harness.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await ensureOwnedWorkspace(repoRoot);
const harnessUrl = new URL('./db-harness.mjs', import.meta.url).href;
const pgBin = process.env.EXTENSIONS_BENCH_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
// Nenhum serviço existente é usado: todos os clusters nascem sob raiz aleatória deste teste.
const fixtureParent = path.join(evidence, 'lifecycle-tests');
await mkdir(fixtureParent, { recursive: true });
const fixture = () => mkdtemp(path.join(fixtureParent, 'owned-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function afterDeath(root, command) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return await runHarness(root, command, { pgBin }); }
    catch (error) { if (!error.message.includes('Lifecycle ocupado')) throw error; await pause(20); }
  }
  throw new Error('Lock não foi liberado depois da morte do supervisor.');
}
async function cleanup(root) {
  // Se stop falhar, não apagar recursos: o próximo operador ainda pode inspecionar/recuperar.
  await afterDeath(root, 'stop');
  await rm(root, { recursive: true });
}

test('recusa cluster desconhecido não vazio antes de chamar qualquer binário PostgreSQL', async () => {
  const root = await fixture();
  const dir = await ensureOwnedWorkspace(root);
  const data = path.join(dir, 'postgres');
  await mkdir(data);
  await writeFile(path.join(data, 'PG_VERSION'), '16');
  await writeFile(path.join(data, 'unknown-sentinel'), 'preserve');
  try {
    for (const command of ['start', 'status', 'stop']) {
      await assert.rejects(runHarness(root, command, { pgBin: '/nonexistent-no-command-can-run' }), /sem registro de criação/);
    }
    assert.equal(await readFile(path.join(data, 'unknown-sentinel'), 'utf8'), 'preserve');
    await assert.rejects(access(path.join(dir, 'cluster.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('cluster próprio atesta owner e papel não dono sem conceder controle; mudança offline impede start', async () => {
  const root = await fixture();
  let originalConfig;
  try {
    const result = await runHarness(root, 'start', { pgBin });
    assert.equal(result.state, 'running');
    const context = await readContext(root);
    const client = await connectBenchDatabase(context);
    try {
      await client.query('create role bench_state_tenant_a login nosuperuser nobypassrls nocreatedb nocreaterole noinherit');
      const tenant = await connectBenchDatabase(context, { user: 'bench_state_tenant_a' });
      try {
        assert.deepEqual((await tenant.query('select current_user,session_user')).rows[0], {
          current_user: 'bench_state_tenant_a', session_user: 'bench_state_tenant_a',
        });
        await assert.rejects(tenant.query('select * from pg_catalog.pg_control_system()'), { code: '42501' });
        await assert.rejects(tenant.query('create table bench_identity.forbidden(id int)'), { code: '42501' });
      } finally { await tenant.end(); }
    } finally { await client.end(); }
    await runHarness(root, 'stop', { pgBin });
    const markerFile = path.join(context.evidenceDir, 'cluster.json');
    const marker = await readJsonPlain(markerFile);
    await writeJsonAtomic(markerFile, { ...marker, system_identifier: '999' });
    await assert.rejects(runHarness(root, 'start', { pgBin }), /Identidade offline/);
    await assert.rejects(access(path.join(context.evidenceDir, 'postgres/postmaster.pid')), { code: 'ENOENT' });
    await writeJsonAtomic(markerFile, marker);
    const config = path.join(context.evidenceDir, 'postgres/postgresql.conf');
    originalConfig = await readFile(config, 'utf8');
    await writeFile(config, `${originalConfig}\ndata_directory = '/synthetic-external-destination'\n`);
    await assert.rejects(runHarness(root, 'start', { pgBin }), /redirecionamento/);
    assert.ok((await readFile(config, 'utf8')).includes('/synthetic-external-destination'));
    await writeFile(config, originalConfig);
    const data = path.join(context.evidenceDir, 'postgres');
    const saved = path.join(context.evidenceDir, 'saved-postgres');
    await rename(data, saved); await mkdir(data);
    try { await assert.rejects(runHarness(root, 'start', { pgBin }), /Propriedade do diretório/); }
    finally { await rm(data, { recursive: true }); await rename(saved, data); }
    assert.equal((await runHarness(root, 'start', { pgBin })).state, 'running');
  } finally {
    if (originalConfig) {
      const dir = await ensureOwnedWorkspace(root);
      await writeFile(path.join(dir, 'postgres/postgresql.conf'), originalConfig);
    }
    await cleanup(root);
  }
});

for (const checkpoint of ['initdb_finished', 'server_started', 'database_created']) {
  test(`SIGKILL após ${checkpoint}: status/stop sem database.json e retomada idempotente`, async () => {
    const root = await fixture();
    try {
      const script = `import {runHarness} from ${JSON.stringify(harnessUrl)}; await runHarness(${JSON.stringify(root)},'start', {pgBin:${JSON.stringify(pgBin)},onPhase:async phase=>{if(phase===${JSON.stringify(checkpoint)})process.kill(process.pid,'SIGKILL')}});`;
      await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: childEnvironment() }), { signal: 'SIGKILL' });
      const dir = await ensureOwnedWorkspace(root);
      await assert.rejects(access(path.join(dir, 'database.json')), { code: 'ENOENT' });
      const status = await afterDeath(root, 'status');
      assert.equal(status.state, checkpoint === 'initdb_finished' ? 'stopped' : 'running');
      assert.equal((await afterDeath(root, 'stop')).state, 'stopped');
      await assert.rejects(access(path.join(dir, 'database.json')), { code: 'ENOENT' });
      const resumed = await runHarness(root, 'start', { pgBin });
      assert.equal(resumed.state, 'running');
      assert.equal(resumed.system_identifier, status.system_identifier);
      const client = await connectBenchDatabase(await readContext(root));
      try { assert.equal((await client.query("select count(*)::int as total from pg_database where datname='extensions_bench'")).rows[0].total, 1); }
      finally { await client.end(); }
      assert.equal((await runHarness(root, 'start', { pgBin })).resumed, true);
    } finally { await cleanup(root); }
  });
}

test('lifecycle concorrente é recusado; SIGKILL libera lock do SO para recuperação', async () => {
  const root = await fixture();
  const script = `import {runHarness} from ${JSON.stringify(harnessUrl)}; await runHarness(${JSON.stringify(root)},'start',{pgBin:${JSON.stringify(pgBin)},onPhase:async phase=>{if(phase==='created'){process.send('created');await new Promise(()=>{})}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Filho saiu antes do checkpoint.'))); });
    await assert.rejects(runHarness(root, 'start', { pgBin }), /Lifecycle ocupado/);
    await assert.rejects(runHarness(root, 'stop', { pgBin }), /Lifecycle ocupado/);
    child.kill('SIGKILL'); await exited;
    assert.equal((await afterDeath(root, 'status')).state, 'incomplete_initdb');
    assert.equal((await afterDeath(root, 'start')).state, 'running');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await cleanup(root);
  }
});
