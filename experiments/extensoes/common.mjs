import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const PURPOSE = 'extensions-architecture-bench';
export const BENCH_OWNER = 'extensions_bench_owner';
export const BENCH_ROLES = [BENCH_OWNER, 'bench_state_tenant_a', 'bench_state_tenant_b'];

/** A bancada só aceita o banco sintético e não permite parâmetros de redirecionamento. */
export function assertLocalDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Endereço inválido da bancada.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1' || url.username !== BENCH_OWNER
    || url.password || url.pathname !== '/extensions_bench'
    || url.search || url.hash || Number(url.port) < 1024 || Number(url.port) > 65535) {
    throw new Error('Conexão recusada: destino não pertence à bancada local.');
  }
  return url.href;
}

async function plainDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('A bancada não aceita diretório simbólico.');
}

export async function readJsonPlain(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Marcador não é arquivo regular.');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function ensureOwnedWorkspace(repoRoot) {
  const root = await realpath(repoRoot);
  let directory = root;
  for (const part of ['.superpowers', 'evidence', 'extensoes-bancada']) {
    directory = path.join(directory, part);
    await plainDirectory(directory);
  }
  const marker = path.join(directory, 'owner.json');
  let owner;
  try { owner = await readJsonPlain(marker); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(directory)).length) throw new Error('Pasta da bancada sem marcador já contém trabalho; preservada.');
    owner = { purpose: PURPOSE, repo_root: root };
    const handle = await open(marker, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
  }
  if (owner.purpose !== PURPOSE || owner.repo_root !== root) throw new Error('Marcador da bancada pertence a outra worktree.');
  return directory;
}

/**
 * Resolve `nome` dentro de `raiz` e recusa o que escaparia dela. O console monta nomes de resultado
 * com o cabeçalho `x-request-id`, que vem do navegador; `validRequestId` já o restringe a UUID, e a
 * contenção mora aqui, no ponto em que o nome vira caminho, para que nenhum chamador dependa de ter
 * lembrado da validação.
 */
export function caminhoDentro(raiz, nome) {
  const base = path.resolve(raiz);
  const alvo = path.resolve(base, nome);
  if (!alvo.startsWith(base + path.sep)) throw new Error('Caminho fora da pasta da bancada recusado.');
  return alvo;
}

/** Arquivo único, sem seguir links; fsync antes da troca e do diretório depois. */
export async function writeJsonAtomic(file, value) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error('Destino da evidência não é arquivo regular.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readContext(repoRoot) {
  const evidenceDir = await ensureOwnedWorkspace(repoRoot);
  const state = await readJsonPlain(path.join(evidenceDir, 'database.json'));
  assertLocalDatabaseUrl(state.database_url);
  return { repoRoot: await realpath(repoRoot), evidenceDir, databaseUrl: state.database_url };
}

/** Não recebe DSN arbitrário. Nunca consulta senha, pgpass ou opções da sessão. */
function newBenchClient(port, database, user) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535
    || !['postgres', 'extensions_bench'].includes(database) || !BENCH_ROLES.includes(user)) {
    throw new Error('Parâmetros fora da bancada.');
  }
  const client = new pg.Client({
    host: '127.0.0.1', port, database, user,
    // Uma função truthy evita PGPASSWORD e pgpass. Trust é a única autenticação admitida.
    password: () => { throw new Error('Desafio de senha recusado pela bancada sem credenciais.'); },
    options: ' ', ssl: false, sslnegotiation: 'postgres',
    client_encoding: 'UTF8', replication: 'false', application_name: 'extensions_bench',
    connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000,
  });
  // pg resolve binary por truthiness; false no construtor permitiria PGBINARY.
  client.binary = false;
  client.connectionParameters.binary = false;
  return client;
}

/** Usada pelo lifecycle, inclusive antes de existir extensions_bench. Sempre atesta a conexão. */
export async function connectOwnedCluster({ port, database = 'postgres', dataDir, systemIdentifier, user = BENCH_OWNER }) {
  const client = newBenchClient(port, database, user);
  try {
    await client.connect();
    const source = user === BENCH_OWNER
      ? `select current_database() as name, session_user as login, current_user as role,
          current_setting('data_directory') as directory,
          system_identifier::text as identity from pg_catalog.pg_control_system()`
      : `select current_database() as name, session_user as login, current_user as role,
          directory, identity from bench_identity.attest()`;
    const { rows: [server] } = await client.query(source);
    if (!server || server.name !== database || server.login !== user || server.role !== user
      || server.directory !== dataDir || server.identity !== systemIdentifier) {
      throw new Error('Servidor não corresponde ao cluster exclusivo da bancada.');
    }
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

/** Toda conexão física entregue ao consumidor já foi atestada, no próprio socket. */
export async function connectBenchDatabase(context, { user = BENCH_OWNER } = {}) {
  const expected = await readContext(context.repoRoot);
  if (context.databaseUrl !== expected.databaseUrl
    || path.resolve(context.evidenceDir) !== expected.evidenceDir) {
    throw new Error('Contexto diferente do marcador da bancada; conexão recusada.');
  }
  const state = await readJsonPlain(path.join(expected.evidenceDir, 'database.json'));
  return connectOwnedCluster({ port: Number(new URL(expected.databaseUrl).port), database: 'extensions_bench',
    dataDir: path.join(expected.evidenceDir, 'postgres'), systemIdentifier: state.system_identifier, user });
}

export async function assertBenchDatabase(context) {
  const client = await connectBenchDatabase(context);
  await client.end();
}

/** Executada só pelo lifecycle, com conexão owner já atestada. Sem acesso a dados de ensaio. */
export async function installIdentityAttestation(client) {
  await client.query(`
    revoke execute on function pg_catalog.pg_control_system() from public;
    create schema if not exists bench_identity authorization extensions_bench_owner;
    revoke all on schema bench_identity from public;
    create or replace function bench_identity.attest()
      returns table(directory text, identity text)
      language sql security definer set search_path = pg_catalog
      as $$ select current_setting('data_directory'), system_identifier::text from pg_catalog.pg_control_system()
        where session_user in ('extensions_bench_owner', 'bench_state_tenant_a', 'bench_state_tenant_b') $$;
    revoke all on function bench_identity.attest() from public;
  `);
  // Uso e execução só revelam identidade local; nenhum grant sobre dados do ensaio.
  await client.query('grant usage on schema bench_identity to public; grant execute on function bench_identity.attest() to public');
}

export function childEnvironment() {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
}
