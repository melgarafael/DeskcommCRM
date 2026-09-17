import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertLocalDatabaseUrl, caminhoDentro, ensureOwnedWorkspace } from './common.mjs';

test('recusa destino remoto e parâmetros que redirecionariam a conexão', () => {
  for (const url of [
    'postgresql://extensions_bench_owner@db.example.com:5432/extensions_bench',
    'postgresql://extensions_bench_owner@127.0.0.1:5432/production',
    'postgresql://extensions_bench_owner@127.0.0.1:5432/extensions_bench?host=db.example.com',
    'postgresql://postgres@127.0.0.1:5432/extensions_bench',
    'postgresql://extensions_bench_owner:secret@127.0.0.1:5432/extensions_bench',
  ]) assert.throws(() => assertLocalDatabaseUrl(url), /bancada/);
  assert.doesNotThrow(() => assertLocalDatabaseUrl(
    'postgresql://extensions_bench_owner@127.0.0.1:54383/extensions_bench',
  ));
});

test('o nome de resultado que vem do navegador não sai da pasta da bancada', () => {
  const raiz = path.join(os.tmpdir(), 'bancada', 'console-results');
  const uuid = '0b7c4a1e-2f3d-4c5b-9a8e-7d6c5b4a3f21';
  assert.equal(caminhoDentro(raiz, `request-${uuid}.json`), path.join(raiz, `request-${uuid}.json`));
  // Os três jeitos de escapar: subir diretório, caminho absoluto, e subir por dentro de um nome.
  for (const nome of ['../owner.json', '/etc/passwd', 'request-x/../../database.json', '..', '']) {
    assert.throws(() => caminhoDentro(raiz, nome), /fora da pasta/, nome);
  }
});

test('recusa ocupar uma pasta que já contém trabalho sem marcador', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extensions-owner-test-'));
  try {
    const evidence = path.join(root, '.superpowers/evidence/extensoes-bancada');
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'trabalho-de-outra-sessao.txt'), 'preservar');
    await assert.rejects(ensureOwnedWorkspace(root), /sem marcador/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('marcador identifica a worktree e permite retomar somente a própria bancada', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extensions-owner-test-'));
  try {
    const evidence = await ensureOwnedWorkspace(root);
    assert.equal(await ensureOwnedWorkspace(root), evidence);
    await writeFile(path.join(evidence, 'owner.json'), JSON.stringify({
      purpose: 'extensions-architecture-bench', repo_root: '/another/worktree',
    }));
    await assert.rejects(ensureOwnedWorkspace(root), /outra worktree/);
  } finally {
    await rm(root, { recursive: true });
  }
});

// Servidor de protocolo mínimo exclusivamente sintético: observa o que sai antes da atestação.
async function protocolServer(handler) {
  const { default: net } = await import('node:net');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let startup = true;
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const length = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (pending.length < length) break;
        const packet = pending.subarray(0, length);
        pending = pending.subarray(length);
        const kind = startup ? 'startup' : String.fromCharCode(packet[0]);
        startup = false;
        handler(socket, kind, packet);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
function message(kind, payload) {
  const header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}
function auth(code) { const payload = Buffer.alloc(4); payload.writeInt32BE(code); return message('R', payload); }
function ready() { return message('Z', Buffer.from('I')); }
function row(values) {
  const names = Object.keys(values);
  const fields = names.map(name => {
    const type = Buffer.alloc(18); type.writeInt32BE(25, 6); type.writeInt16BE(-1, 10); type.writeInt32BE(-1, 12);
    return Buffer.concat([Buffer.from(`${name}\0`), type]);
  });
  const count = Buffer.alloc(2); count.writeInt16BE(names.length);
  const data = names.map(name => {
    const value = Buffer.from(values[name]); const length = Buffer.alloc(4); length.writeInt32BE(value.length);
    return Buffer.concat([length, value]);
  });
  return Buffer.concat([message('T', Buffer.concat([count, ...fields])), message('D', Buffer.concat([count, ...data])),
    message('C', Buffer.from('SELECT 1\0')), ready()]);
}
async function syntheticContext(port) {
  const { writeJsonAtomic } = await import('./common.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'extensions-wire-test-'));
  const evidenceDir = await ensureOwnedWorkspace(root);
  const databaseUrl = `postgresql://extensions_bench_owner@127.0.0.1:${port}/extensions_bench`;
  await writeJsonAtomic(path.join(evidenceDir, 'database.json'), { database_url: databaseUrl, system_identifier: '12345' });
  return { repoRoot: root, evidenceDir, databaseUrl };
}

test('desafio cleartext nunca recebe PGPASSWORD/pgpass e startup ignora PGOPTIONS (controle inseguro incluído)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { childEnvironment } = await import('./common.mjs');
  for (const source of ['PGPASSWORD', 'pgpass']) {
    const observed = [];
    const server = await protocolServer((socket, kind, packet) => {
      observed.push({ kind, data: packet.toString() });
      if (kind === 'startup') socket.write(auth(3));
      if (kind === 'p') socket.end();
    });
    const context = await syntheticContext(server.port);
    const passfile = path.join(context.evidenceDir, 'synthetic.pgpass');
    const sentinel = `SYNTHETIC_${source}_NEVER_REAL`;
    await writeFile(passfile, `127.0.0.1:${server.port}:extensions_bench:extensions_bench_owner:${sentinel}\n`, { mode: 0o600 });
    const env = { ...childEnvironment(), HOME: context.evidenceDir, PGPASSFILE: passfile,
      PGOPTIONS: '-c application_name=SYNTHETIC_OPTIONS', PGAPPNAME: 'SYNTHETIC_APP', PGBINARY: 'true',
      PGSSLNEGOTIATION: 'direct', PGCLIENT_ENCODING: 'LATIN1', PGREPLICATION: 'database',
      ...(source === 'PGPASSWORD' ? { PGPASSWORD: sentinel } : {}) };
    try {
      // Controle causal: pg sem a fábrica realmente envia a sentinela ao mesmo servidor.
      const unsafe = `import pg from 'pg'; const c=new pg.Client({host:'127.0.0.1',port:${server.port},user:'extensions_bench_owner',database:'extensions_bench',ssl:false,sslnegotiation:'postgres',connectionTimeoutMillis:1000}); try {await c.connect()} catch {} finally {await c.end()}`;
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', unsafe], { env });
      assert.ok(observed.some(item => item.kind === 'p' && item.data.includes(sentinel)), 'Controle inseguro precisa transmitir a sentinela');
      observed.length = 0;
      const safe = `import {connectBenchDatabase} from ${JSON.stringify(new URL('./common.mjs', import.meta.url).href)}; try {await connectBenchDatabase(${JSON.stringify(context)});process.exitCode=2} catch(e) {if(!e.message.includes('Desafio de senha recusado'))throw e}`;
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', safe], { env });
      assert.equal(observed.some(item => item.kind === 'p'), false, 'Nenhum pacote de senha pode sair');
      const startup = observed.find(item => item.kind === 'startup').data;
      for (const text of [sentinel, 'SYNTHETIC_OPTIONS', 'SYNTHETIC_APP', 'LATIN1']) assert.equal(startup.includes(text), false);
      assert.ok(startup.includes('extensions_bench'));
    } finally { await server.close(); await rm(context.repoRoot, { recursive: true }); }
  }
});

test('cada socket é atestado antes de devolver cliente; troca de identidade impede SQL consumidor', async () => {
  const { connectBenchDatabase } = await import('./common.mjs');
  let context;
  let identity = '12345';
  let connection = 0;
  const queries = [];
  const ids = new WeakMap();
  const server = await protocolServer((socket, kind, packet) => {
    if (kind === 'startup') { ids.set(socket, ++connection); socket.write(Buffer.concat([auth(0), ready()])); }
    if (kind === 'Q') {
      const sql = packet.subarray(5, -1).toString();
      queries.push({ socket: ids.get(socket), sql });
      socket.write(row({ name: 'extensions_bench', login: 'extensions_bench_owner', role: 'extensions_bench_owner',
        directory: path.join(context.evidenceDir, 'postgres'), identity }));
    }
    if (kind === 'X') socket.end();
  });
  context = await syntheticContext(server.port);
  try {
    const first = await connectBenchDatabase(context);
    await first.query('select 42 as consumer_marker');
    await first.end();
    assert.equal(queries.length, 2);
    assert.match(queries[0].sql, /pg_control_system/);
    assert.equal(queries[0].socket, queries[1].socket);
    identity = '67890';
    await assert.rejects(async () => {
      const second = await connectBenchDatabase(context);
      await second.query('drop schema consumer_must_not_run cascade');
    }, /não corresponde/);
    assert.equal(queries.length, 3);
    assert.equal(queries[2].socket, 2);
    assert.match(queries[2].sql, /pg_control_system/);
    assert.equal(queries.some(item => item.sql.includes('drop schema')), false);
  } finally { await server.close(); await rm(context.repoRoot, { recursive: true }); }
});

test('escrita atômica recusa arquivo simbólico e preserva destino', async () => {
  const { symlink, readFile } = await import('node:fs/promises');
  const { writeJsonAtomic } = await import('./common.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'extensions-write-test-'));
  try {
    const target = path.join(root, 'sentinel'); const link = path.join(root, 'result.json');
    await writeFile(target, 'synthetic-preserve'); await symlink(target, link);
    await assert.rejects(writeJsonAtomic(link, { changed: true }), /arquivo regular/);
    assert.equal(await readFile(target, 'utf8'), 'synthetic-preserve');
  } finally { await rm(root, { recursive: true }); }
});
