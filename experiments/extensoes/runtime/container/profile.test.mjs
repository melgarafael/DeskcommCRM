import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { engineClient } from './engine.mjs';
import { IMAGE, LIMITS, assertEffectiveProfile, createConfig, identity, imageReference } from './profile.mjs';
import { cleanupEntry, executeProfile } from './runner.mjs';
import { WORKLOAD_SOURCE, decodeLogs, decodeWorkload } from './workload.mjs';

function frame(text, stream = 1) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
function value() {
  return { protocol: 1, value: 41, denied: 2, node: 'v22.22.3', platform: 'linux', arch: 'arm64',
    uid: 65534, warm_call_ms: Array(50).fill(0.01), rss_peak_bytes: 1000, cpu_us: 10 };
}
function fakeEngine({ unavailable = false, wrongOwner = false, quotaMismatch = false } = {}) {
  const calls = [];
  const containers = new Map();
  let serial = 0;
  const api = async (method, path, options = {}) => {
    calls.push({ method, path, options });
    if (unavailable) throw Object.assign(new Error('daemon sintético indisponível'), { code: 'DOCKER_TIMEOUT' });
    if (path === '/_ping') return Buffer.from('OK');
    if (path === '/version') return Buffer.from(JSON.stringify({ Os: 'linux', Arch: 'aarch64', ApiVersion: '1.45', Version: 'synthetic' }));
    if (path.includes('/images/')) return Buffer.from(JSON.stringify({ Os: 'linux', Architecture: 'arm64', RepoDigests: [imageReference('arm64')], Id: 'sha256:synthetic' }));
    if (path.includes('/containers/create')) {
      const id = (++serial).toString(16).padStart(64, '0');
      const config = structuredClone(options.body);
      if (wrongOwner) config.Labels['org.extensions-bench.round'] = randomUUID();
      const hc = structuredClone(config.HostConfig);
      if (quotaMismatch) hc.Memory = 0;
      containers.set(id, { Id: id, Name: `/${new URL(path, 'http://local').searchParams.get('name')}`,
        Config: config, HostConfig: hc, Mounts: [], State: { Running: false, ExitCode: 0, OOMKilled: false } });
      return Buffer.from(JSON.stringify({ Id: id }));
    }
    const id = path.match(/containers\/([^/?]+)/)?.[1];
    const container = containers.get(id) ?? [...containers.values()].find((item) => item.Name === `/${id}`);
    if (!container) throw Object.assign(new Error('not found'), { status: 404 });
    if (path.endsWith('/json')) return Buffer.from(JSON.stringify(container));
    if (path.endsWith('/start')) { container.State.Running = true; return Buffer.alloc(0); }
    if (path.includes('/kill')) { container.State.Running = false; container.State.ExitCode = 137; return Buffer.alloc(0); }
    if (path.includes('/wait')) {
      if (container.Config.Cmd.at(-1) === 'runaway' && container.State.Running) throw Object.assign(new Error('timeout sintético'), { code: 'DOCKER_TIMEOUT' });
      container.State.Running = false;
      return Buffer.from(JSON.stringify({ StatusCode: container.State.ExitCode }));
    }
    if (path.includes('/logs')) return frame(container.Config.Cmd.at(-1) === 'runaway' ? 'LOOP_ENTERED\n' : JSON.stringify(value()));
    if (method === 'DELETE') { containers.delete(container.Id); return Buffer.alloc(0); }
    throw new Error(`Chamada não esperada: ${method} ${path}`);
  };
  return { api, calls, containers };
}

test('perfil fixa imagem, quotas, identidade e ausência de mounts/segredos', () => {
  for (const arch of ['amd64', 'arm64']) {
    const expected = identity('/synthetic/worktree', randomUUID(), 0);
    const config = createConfig({ arch, labels: expected.labels });
    assert.match(config.Image, /^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/);
    assert.equal(config.Image.endsWith(IMAGE[arch]), true);
    assert.equal(config.User, '65534:65534');
    assert.equal(config.HostConfig.NetworkMode, 'none');
    assert.equal(config.HostConfig.Memory, LIMITS.memory);
    assert.equal(config.HostConfig.MemorySwap, LIMITS.memory);
    assert.equal(config.HostConfig.PidsLimit, 32);
    assert.equal(config.HostConfig.NanoCpus, 500_000_000);
    assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(config.HostConfig.Binds, []);
    assert.deepEqual(config.HostConfig.Mounts, []);
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges:true']);
    assert.equal(config.HostConfig.Privileged, false);
    assert.deepEqual(config.HostConfig.LogConfig, { Type: 'local', Config: {
      'max-size': '1m', 'max-file': '1', compress: 'false',
    } });
    assert.equal(config.Env.some((entry) => /TOKEN|PASSWORD|SECRET|DOCKER/i.test(entry)), false);
    assertEffectiveProfile({ Config: config, HostConfig: config.HostConfig, Mounts: [] }, config);
    assert.throws(() => assertEffectiveProfile({ Config: config, HostConfig: { ...config.HostConfig, Memory: 0 }, Mounts: [] }, config));
    assert.throws(() => assertEffectiveProfile({ Config: config, HostConfig: { ...config.HostConfig,
      LogConfig: { Type: 'local', Config: { ...config.HostConfig.LogConfig.Config, compress: 'true' } } }, Mounts: [] }, config), /logs/);
  }
});

test('preflight indisponível bloqueia run e pull sem mutação ou medição', async () => {
  for (const mode of ['run', 'pull']) {
    const fake = fakeEngine({ unavailable: true });
    const report = await executeProfile(fake.api, { repoRoot: '/synthetic/worktree', mode });
    assert.equal(report.status, 'blocked');
    assert.equal(report.measurements, null);
    assert.deepEqual(fake.calls.map(({ method, path }) => [method, path]), [['GET', '/_ping']]);
  }
});

test('protocolo completo sintético aplica perfil, mata loop e remove apenas IDs próprios', async () => {
  const fake = fakeEngine();
  const report = await executeProfile(fake.api, { repoRoot: '/synthetic/worktree', mode: 'run' });
  assert.equal(report.status, 'passed');
  assert.equal(report.containers.length, 15);
  assert.equal(report.measurements.cold.length, 5);
  assert.equal(report.measurements.concurrent.length, 8);
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.calls.filter((call) => call.path.includes('/kill')).length, 1);
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 15);
  assert.equal(fake.calls.some((call) => /prune|reset|images\/create/.test(call.path)), false);
  assert.ok(fake.calls.filter((call) => call.method === 'DELETE').every((call) => /containers\/[a-f0-9]{64}\?force=false&v=false$/.test(call.path)));
});

test('perfil efetivo divergente impede start; limpeza limitada ao criado próprio', async () => {
  const fake = fakeEngine({ quotaMismatch: true });
  const report = await executeProfile(fake.api, { repoRoot: '/synthetic/worktree', mode: 'run' });
  assert.equal(report.status, 'failed');
  assert.equal(report.measurements, null);
  assert.equal(fake.calls.some((call) => call.path.endsWith('/start')), false);
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 1);
});

test('label alheia impede start, kill e remove; journal registra pendência', async () => {
  const fake = fakeEngine({ wrongOwner: true });
  const report = await executeProfile(fake.api, { repoRoot: '/synthetic/worktree', mode: 'run' });
  assert.equal(report.status, 'failed');
  assert.equal(report.containers[0].phase, 'cleanup_pending');
  assert.equal(fake.calls.some((call) => /\/start|\/kill/.test(call.path) || call.method === 'DELETE'), false);
});

test('limpeza não adota colisão de nome ou entrada nunca criada', async () => {
  const fake = fakeEngine();
  for (const phase of ['planned', 'name_conflict', 'removed']) {
    await cleanupEntry(fake.api, { index: 0, phase, ...(phase === 'removed' ? { id: 'd'.repeat(64) } : {}) }, '/synthetic/worktree', randomUUID());
  }
  assert.equal(fake.calls.length, 0);
});

test('create tardio continua reconsultável após timeout e 404, inclusive por journal reaberto', async () => {
  const fake = fakeEngine();
  const repoRoot = '/synthetic/worktree';
  let delayed;
  const api = async (method, path, options) => {
    if (path.includes('/containers/create')) {
      fake.calls.push({ method, path, options });
      delayed = { Id: 'a'.repeat(64),
        Name: `/${new URL(path, 'http://local').searchParams.get('name')}`,
        Config: structuredClone(options.body), HostConfig: structuredClone(options.body.HostConfig),
        Mounts: [], State: { Running: true, ExitCode: 0, OOMKilled: false } };
      throw Object.assign(new Error('create aceito, resposta atrasada'), { code: 'DOCKER_TIMEOUT' });
    }
    return fake.api(method, path, options);
  };
  const report = await executeProfile(api, { repoRoot, mode: 'run' });
  assert.equal(report.status, 'failed');
  assert.equal(report.measurements, null);
  assert.equal(report.containers[0].phase, 'cleanup_pending');
  assert.equal(report.containers[0].id, undefined);
  // JSON roundtrip reproduz a retomada do arquivo, sem identidade só em memória.
  const saved = JSON.parse(JSON.stringify(report));
  await cleanupEntry(fake.api, saved.containers[0], repoRoot, saved.round);
  assert.equal(saved.containers[0].phase, 'cleanup_pending');
  const foreign = { ...structuredClone(delayed), Id: 'b'.repeat(64), Name: '/foreign-sentinel' };
  foreign.Config.Labels['org.extensions-bench.round'] = randomUUID();
  fake.containers.set(foreign.Id, foreign);
  fake.containers.set(delayed.Id, delayed); // create conclui somente depois dos dois 404.
  await cleanupEntry(fake.api, saved.containers[0], repoRoot, saved.round);
  assert.equal(saved.containers[0].phase, 'removed');
  assert.equal(saved.containers[0].id, delayed.Id);
  assert.equal(fake.containers.has(delayed.Id), false);
  assert.equal(fake.containers.get(foreign.Id).State.Running, true);
  assert.equal(fake.calls.some((call) => call.path.includes(foreign.Id)), false);
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 1);
});

test('nome tardio com labels alheias permanece pendente e não sofre kill/remove', async () => {
  const fake = fakeEngine();
  const repoRoot = '/synthetic/worktree';
  const round = randomUUID();
  const expected = identity(repoRoot, round, 0);
  const entry = { index: 0, name: expected.name, phase: 'create_uncertain' };
  await cleanupEntry(fake.api, entry, repoRoot, round);
  assert.equal(entry.phase, 'cleanup_pending');
  const id = 'c'.repeat(64);
  fake.containers.set(id, { Id: id, Name: `/${expected.name}`,
    Config: { Labels: { ...expected.labels, 'org.extensions-bench.owner': 'other-owner' } },
    State: { Running: true } });
  await cleanupEntry(fake.api, entry, repoRoot, round);
  assert.equal(entry.phase, 'cleanup_pending');
  assert.equal(entry.id, undefined);
  assert.equal(fake.containers.get(id).State.Running, true);
  assert.equal(fake.calls.some((call) => call.method !== 'GET'), false);
});

test('404 de ID confirmado é terminal; removed antigo sem ID volta a ser consultado', async () => {
  const fake = fakeEngine();
  const round = randomUUID();
  const root = '/synthetic/worktree';
  const known = { index: 0, id: 'e'.repeat(64), phase: 'cleanup_pending', cleanup_error: 'anterior' };
  await cleanupEntry(fake.api, known, root, round);
  assert.equal(known.phase, 'removed');
  assert.equal(known.cleanup_error, undefined);
  assert.equal(fake.calls.length, 1);
  await cleanupEntry(fake.api, known, root, round);
  assert.equal(fake.calls.length, 1);
  const legacy = { index: 1, phase: 'removed' };
  await cleanupEntry(fake.api, legacy, root, round);
  assert.equal(legacy.phase, 'cleanup_pending');
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls[1].path.includes(identity(root, round, 1).name));
});

test('logs Docker e resultado são limitados e falham em truncamento/conteúdo incorreto', () => {
  const result = decodeLogs(Buffer.concat([frame(JSON.stringify(value())), frame('aviso', 2)]));
  assert.equal(result.stderr, 'aviso');
  assert.equal(decodeWorkload(result.stdout).value, 41);
  assert.throws(() => decodeLogs(Buffer.alloc(3)), /truncado/);
  assert.throws(() => decodeLogs(frame('12345'), 4), /limite/);
  assert.throws(() => decodeWorkload(JSON.stringify({ ...value(), uid: 0 })), /inválido/);
  assert.throws(() => decodeWorkload(JSON.stringify({ ...value(), denied: 0 })), /inválido/);
});

test('fixture funcional roda localmente com ambiente sintético, sem provar quotas Docker', () => {
  const result = spawnSync(process.execPath, ['-e', WORKLOAD_SOURCE, 'valid'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.value, 41);
  assert.equal(data.denied, 2);
  assert.equal(data.warm_call_ms.length, 50);
});

test('cliente limita prazo e preserva diagnóstico JSON de HTTP 500 sintético', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ext-container-api-'));
  const socket = join(directory, 'engine.sock');
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/synthetic-failure') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'synthetic_logging_option_failure' }));
    }
  });
  server.on('connection', (client) => { sockets.add(client); client.on('close', () => sockets.delete(client)); });
  t.after(async () => {
    for (const client of sockets) client.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  await assert.rejects(engineClient(socket)('GET', '/_ping', { timeout: 30 }), { code: 'DOCKER_TIMEOUT' });
  await assert.rejects(engineClient(socket)('POST', '/synthetic-failure'), (error) =>
    error.status === 500 && error.message.includes('POST /synthetic-failure')
    && error.message.includes('synthetic_logging_option_failure'));
});
