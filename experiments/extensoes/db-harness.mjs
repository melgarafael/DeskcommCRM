import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnvironment, connectOwnedCluster, ensureOwnedWorkspace, installIdentityAttestation,
  readJsonPlain, assertLocalDatabaseUrl, writeJsonAtomic } from './common.mjs';

const execute = promisify(execFile);
const defaultPgBin = '/opt/homebrew/opt/postgresql@16/bin';
const PURPOSE = 'extensions-architecture-cluster-v2';
const configFiles = ['postgresql.conf', 'postgresql.auto.conf', 'pg_hba.conf', 'pg_ident.conf'];

async function maybeJson(file) {
  try { return await readJsonPlain(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** flock do SO: exclusão entre processos, liberada também quando o Node morre (EOF no pipe). */
async function lifecycleLock(evidenceDir) {
  const child = spawn('python3', ['-I', '-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
print('locked', flush=True)
sys.stdin.buffer.read()
`, path.join(evidenceDir, 'lifecycle.lock')], { env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', data => data.toString().trim() === 'locked' ? resolve() : reject(new Error('Lock inválido.')));
    child.once('close', code => reject(new Error(code === 73 ? 'Lifecycle ocupado por outro processo.' : 'Não foi possível obter lock de lifecycle.')));
  });
  return async () => { child.stdin.end(); await closed; };
}

async function directoryIdentity(dataDir) {
  const info = await lstat(dataDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diretório do cluster inválido.');
  return { dev: String(info.dev), ino: String(info.ino) };
}
async function configIdentity(dataDir) {
  // Não ler configurações redirecionadas nem permitir tablespaces externos nesta bancada.
  for (const entry of await readdir(dataDir)) {
    if ((await lstat(path.join(dataDir, entry))).isSymbolicLink()) throw new Error('Link no cluster recusado.');
  }
  if ((await readdir(path.join(dataDir, 'pg_tblspc'))).length) throw new Error('Tablespace externo recusado.');
  const hashes = {};
  for (const name of configFiles) {
    const file = path.join(dataDir, name);
    if (!(await lstat(file)).isFile()) throw new Error('Configuração do cluster inválida.');
    const content = await readFile(file, 'utf8');
    if (/^\s*(include(?:_if_exists|_dir)?|data_directory|hba_file|ident_file|external_pid_file|ssl|(?:shared|session|local)_preload_libraries|archive_command|restore_command|archive_library|primary_conninfo|primary_slot_name)\s*(?:=|\s)/m.test(content)) {
      throw new Error('Configuração com redirecionamento ou execução externa recusada.');
    }
    hashes[name] = createHash('sha256').update(content).digest('hex');
  }
  return hashes;
}

/** API importável permite provas com raízes sintéticas próprias; CLI usa apenas sua worktree. */
export async function runHarness(root, command, { pgBin = defaultPgBin, onPhase = async () => {}, expectedIdentity } = {}) {
  const repoRoot = await realpath(root);
  const evidenceDir = await ensureOwnedWorkspace(repoRoot);
  const release = await lifecycleLock(evidenceDir);
  const dataDir = path.join(evidenceDir, 'postgres');
  const markerFile = path.join(evidenceDir, 'cluster.json');
  const databaseFile = path.join(evidenceDir, 'database.json');
  const run = (binary, args) => execute(path.join(pgBin, binary), args, {
    env: childEnvironment(), timeout: 25000, maxBuffer: 1024 * 1024,
  });
  const offlineIdentity = async () => {
    if (!(await lstat(path.join(dataDir, 'global'))).isDirectory()
      || !(await lstat(path.join(dataDir, 'global/pg_control'))).isFile()) {
      throw new Error('Controle offline não é arquivo local regular.');
    }
    const { stdout } = await run('pg_controldata', ['-D', dataDir]);
    const identity = stdout.match(/^Database system identifier:\s+(\d+)$/m)?.[1];
    if (!identity) throw new Error('Controle offline do cluster inválido.');
    return identity;
  };
  const running = async () => {
    try { await run('pg_ctl', ['-D', dataDir, 'status']); return true; }
    catch (error) { if (error.code === 3) return false; throw error; }
  };
  let marker;
  const persist = async phase => {
    marker.phase = phase;
    await writeJsonAtomic(markerFile, marker);
    await onPhase(phase);
  };
  const verifyDirectory = async () => {
    const info = await directoryIdentity(dataDir);
    if (marker.purpose !== PURPOSE || marker.repo_root !== repoRoot || marker.data_directory !== dataDir
      || marker.directory.dev !== info.dev || marker.directory.ino !== info.ino) {
      throw new Error('Propriedade do diretório do cluster não corresponde ao registro.');
    }
    assertLocalDatabaseUrl(marker.database_url);
  };
  const verifyOffline = async () => {
    await verifyDirectory();
    if (JSON.stringify(await configIdentity(dataDir)) !== JSON.stringify(marker.config_hashes)) {
      throw new Error('Configuração do cluster mudou; recurso preservado.');
    }
    if (await offlineIdentity() !== marker.system_identifier) throw new Error('Identidade offline do cluster mudou.');
  };
  const connect = (database = 'postgres') => connectOwnedCluster({
    port: Number(new URL(marker.database_url).port), database, dataDir, systemIdentifier: marker.system_identifier,
  });
  try {
    if (!['start', 'status', 'stop', 'upgrade'].includes(command)) throw new Error('Use start, status, stop ou upgrade.');
    marker = await maybeJson(markerFile);
    if (!marker && command === 'upgrade') {
      // Migração explícita só de uma bancada LEGADA VIVA: duas identidades independentes + pin humano.
      const legacy = await readJsonPlain(databaseFile);
      assertLocalDatabaseUrl(legacy.database_url);
      if (!expectedIdentity || expectedIdentity !== legacy.system_identifier) throw new Error('Upgrade exige identidade previamente registrada explicitamente.');
      const directory = await directoryIdentity(dataDir);
      const config_hashes = await configIdentity(dataDir);
      if (await offlineIdentity() !== expectedIdentity) throw new Error('Identidade offline do cluster mudou.');
      marker = { purpose: PURPOSE, repo_root: repoRoot, data_directory: dataDir, directory,
        database_url: legacy.database_url, system_identifier: expectedIdentity, config_hashes,
        creation_id: randomUUID(), migrated_from_attested_legacy: true };
      const client = await connect('extensions_bench');
      try { await installIdentityAttestation(client); } finally { await client.end(); }
      await persist('ready');
      return { state: 'running', migrated: true, system_identifier: expectedIdentity };
    }
    if (!marker) {
      if (await exists(dataDir)) await directoryIdentity(dataDir);
      if (await exists(dataDir) && (await readdir(dataDir)).length) {
        throw new Error('Cluster não vazio sem registro de criação; preservado. Bancada legada exige upgrade explícito.');
      }
      if (command !== 'start') return { state: 'absent', data_preserved: true };
      if (await exists(dataDir)) await directoryIdentity(dataDir);
      else await mkdir(dataDir, { mode: 0o700 });
      marker = { purpose: PURPOSE, repo_root: repoRoot, data_directory: dataDir,
        directory: await directoryIdentity(dataDir), creation_id: randomUUID(),
        database_url: `postgresql://extensions_bench_owner@127.0.0.1:${await freePort()}/extensions_bench` };
      await persist('created');
    }
    await verifyDirectory();
    if (!marker.system_identifier) {
      const hasVersion = await exists(path.join(dataDir, 'PG_VERSION'));
      if (!hasVersion && command === 'start' && (await readdir(dataDir)).length === 0) {
        await run('initdb', ['-D', dataDir, '-U', 'extensions_bench_owner',
          '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C']);
        await onPhase('initdb_finished');
      } else if (!hasVersion) {
        // Initdb parcial nunca é adotado ou apagado; nenhum servidor pode ser iniciado daqui.
        if (command === 'start') throw new Error('Initdb incompleto; arquivos preservados para inspeção.');
        return { state: 'incomplete_initdb', data_preserved: true };
      }
      marker.system_identifier = await offlineIdentity();
      marker.config_hashes = await configIdentity(dataDir);
      await persist('initialized');
    }
    await verifyOffline();
    const active = await running();
    if (command === 'stop') {
      if (active) {
        const client = await connect();
        await client.end();
        await persist('stop_requested');
        await run('pg_ctl', ['-D', dataDir, '-w', '-t', '15', '-m', 'fast', 'stop']);
      }
      await persist('stopped');
      return { state: 'stopped', data_preserved: true };
    }
    if (command === 'status' || command === 'upgrade') {
      if (active) { const client = await connect(); await client.end(); }
      return { state: active ? 'running' : 'stopped', phase: marker.phase, system_identifier: marker.system_identifier };
    }
    if (!active) {
      // Identidade e configurações conferidas ANTES do pg_ctl; porta e intenção já estão duráveis.
      await persist('start_requested');
      const options = ['-h', '127.0.0.1', '-p', new URL(marker.database_url).port, '-k', '',
        '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'max_connections=30'].map(quote).join(' ');
      await run('pg_ctl', ['-D', dataDir, '-l', path.join(evidenceDir, 'postgres.log'), '-o', options, '-w', '-t', '15', 'start']);
      await onPhase('server_started');
    }
    await persist('server_started');
    const client = await connect();
    let version;
    try {
      version = (await client.query('select version() as version')).rows[0].version;
      if (!(await client.query("select 1 from pg_database where datname='extensions_bench'")).rowCount) {
        await client.query('create database extensions_bench');
      }
      await onPhase('database_created');
    } finally { await client.end(); }
    await persist('database_created');
    const target = await connect('extensions_bench');
    try { await installIdentityAttestation(target); } finally { await target.end(); }
    await writeJsonAtomic(databaseFile, { database_url: marker.database_url, system_identifier: marker.system_identifier,
      version, scope: 'isolated_native_experiment_not_supabase_pg15' });
    await persist('ready');
    return { state: 'running', database_url: marker.database_url, system_identifier: marker.system_identifier, resumed: active };
  } finally { await release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await runHarness(root, process.argv[2] ?? 'status', {
      pgBin: process.env.EXTENSIONS_BENCH_PG_BIN ?? defaultPgBin, expectedIdentity: process.argv[3],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Bancada: ${error.message}\n`);
    process.exitCode = 1;
  }
}
