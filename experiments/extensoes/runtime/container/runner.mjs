import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { RUNTIME_REPO_ROOT, validateRuntimeWorkspace } from '../workspace.mjs';
import { readJsonPlain, writeJsonAtomic } from '../../common.mjs';
import { API_VERSION, engineClient, json, preflight } from './engine.mjs';
import { IMAGE, LIMITS, assertEffectiveProfile, assertOwnedContainer, createConfig, identity,
  imageReference, platformForDaemon } from './profile.mjs';
import { decodeLogs, decodeWorkload } from './workload.mjs';

const LIMITATIONS = [
  'Perfil experimental de Node Linux em contêiner; não é equivalente ao guest Wasm core sem WASI.',
  'A closure de leitura replica o workload funcional, mas não prova proteção da autoridade contra JavaScript hostil.',
  'Node dispõe de APIs de filesystem/processo e pode ler a imagem; rede none preserva loopback.',
  'Medições de processo Node não medem todo o custo da VM Docker Desktop ou do daemon.',
  'macOS ARM nativo versus contêiner Linux numa VM não decide o executor de uma VPS Linux amd64.',
  'Se o daemon ficar indisponível após create/start, a limpeza pode ficar pendente; retomar apenas o journal desta rodada.',
];

function summary(samples) {
  return { n: samples.length, samples, mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    min: Math.min(...samples), max: Math.max(...samples) };
}

async function inspectOwned(api, entry, repoRoot, round) {
  const expected = identity(repoRoot, round, entry.index);
  const target = entry.id ?? expected.name;
  const actual = await json(api, 'GET', `/containers/${target}/json`);
  if (!/^[a-f0-9]{64}$/.test(actual.Id)) throw new Error('ID de contêiner inválido.');
  assertOwnedContainer(actual, expected, entry.id ?? actual.Id);
  return actual;
}

/** Só usa IDs/nome exatos do journal, reconferidos por três labels e nome. */
export async function cleanupEntry(api, entry, repoRoot, round) {
  // Compatibilidade com journal anterior: removed sem ID veio de um 404 incerto,
  // nunca de DELETE confirmado. Continua consultável pelo nome próprio da rodada.
  if (entry.phase === 'removed' && !entry.id) entry.phase = 'cleanup_pending';
  if (!['created', 'started', 'finished', 'create_uncertain', 'cleanup_pending'].includes(entry.phase)) return;
  try {
    const actual = await inspectOwned(api, entry, repoRoot, round);
    entry.id = actual.Id;
    if (actual.State.Running) {
      await api('POST', `/v${API_VERSION}/containers/${entry.id}/kill?signal=SIGKILL`);
      await json(api, 'POST', `/containers/${entry.id}/wait?condition=not-running`);
    }
    await inspectOwned(api, entry, repoRoot, round);
    await api('DELETE', `/v${API_VERSION}/containers/${entry.id}?force=false&v=false`);
    entry.phase = 'removed';
    delete entry.cleanup_error;
  } catch (error) {
    if (error.status === 404 && entry.id) {
      entry.phase = 'removed';
      delete entry.cleanup_error;
    } else if (error.status === 404) {
      // O create pode continuar no daemon depois que a resposta HTTP expirou.
      // Ausência momentânea pelo nome não comprova cancelamento da criação.
      entry.phase = 'cleanup_pending';
      entry.cleanup_error = 'Criação sem ID confirmado; nome ainda ausente. Reconsultar esta rodada após estabilizar o daemon.';
    }
    else { entry.phase = 'cleanup_pending'; entry.cleanup_error = error.message; }
  }
}

/** API e persistência injetáveis permitem testar protocolo sem daemon. */
export async function executeProfile(api, { repoRoot, mode = 'check', record = async () => {} }) {
  if (!['check', 'pull', 'run'].includes(mode)) throw new Error('Modo não admitido.');
  const report = { id: 'container-comparison', round: randomUUID(), repo_root: repoRoot, mode,
    status: 'blocked', profile: { image: IMAGE, limits: LIMITS }, checks: [], measurements: null,
    containers: [], limitations: [...LIMITATIONS], preflight: await preflight(api) };
  await record(report);
  if (report.preflight.status !== 'ready') {
    report.reason = report.preflight.reason;
    await record(report);
    return report;
  }
  const arch = platformForDaemon(report.preflight.version.Arch);
  const reference = imageReference(arch);
  report.profile.platform = `linux/${arch}`;
  report.profile.reference = reference;
  if (mode === 'check') {
    report.status = 'ready';
    report.reason = 'API disponível; nenhum pull, contêiner ou medição executado.';
    await record(report);
    return report;
  }
  if (mode === 'pull') {
    const query = new URLSearchParams({ fromImage: 'docker.io/library/node', tag: IMAGE[arch], platform: `linux/${arch}` });
    const output = (await api('POST', `/v${API_VERSION}/images/create?${query}`, { timeout: 60_000, maxBytes: 2 * 1024 * 1024 })).toString('utf8');
    for (const line of output.split('\n').filter(Boolean)) {
      if (JSON.parse(line).error) throw new Error('Registry recusou download da imagem fixada.');
    }
  }
  let image;
  try { image = await json(api, 'GET', `/images/${encodeURIComponent(reference)}/json`); }
  catch (error) {
    if (error.status !== 404) throw error;
    report.reason = 'Imagem fixada ausente. Executar --pull explicitamente com o daemon disponível.';
    await record(report);
    return report;
  }
  if (image.Os !== 'linux' || image.Architecture !== arch
    || !image.RepoDigests?.some((digest) => digest.endsWith(`@${IMAGE[arch]}`))) throw new Error('Digest/plataforma da imagem local divergente.');
  report.profile.local_image_id = image.Id;
  if (mode === 'pull') {
    report.status = 'ready';
    report.reason = 'Imagem fixada presente e conferida; nenhum workload executado.';
    await record(report);
    return report;
  }

  let nextIndex = 0;
  async function sample(workload = 'valid') {
    const index = nextIndex++;
    const expected = identity(repoRoot, report.round, index);
    const entry = { index, name: expected.name, phase: 'planned' };
    report.containers.push(entry);
    await record(report); // Nome/rodada duráveis antes da primeira mutação.
    const config = createConfig({ arch, labels: expected.labels, mode: workload });
    const start = performance.now();
    try {
      entry.phase = 'create_uncertain';
      await record(report);
      let created;
      try {
        created = await json(api, 'POST', `/containers/create?${new URLSearchParams({ name: expected.name, platform: `linux/${arch}` })}`, { body: config });
      } catch (error) {
        if (error.status === 409) entry.phase = 'name_conflict';
        throw error;
      }
      if (!/^[a-f0-9]{64}$/.test(created.Id)) throw new Error('Resposta create sem ID válido.');
      entry.id = created.Id;
      entry.phase = 'created';
      await record(report);
      const effective = await inspectOwned(api, entry, repoRoot, report.round);
      assertEffectiveProfile(effective, config);
      report.profile.effective ??= { User: effective.Config.User, HostConfig: effective.HostConfig, Mounts: effective.Mounts };
      await api('POST', `/v${API_VERSION}/containers/${entry.id}/start`);
      entry.phase = 'started';
      await record(report);
      let killedAfterMs = null;
      if (workload === 'runaway') {
        const deadline = performance.now() + LIMITS.executionMs;
        let entered = false;
        while (performance.now() < deadline) {
          const logs = decodeLogs(await api('GET', `/v${API_VERSION}/containers/${entry.id}/logs?stdout=true&stderr=true`, { maxBytes: LIMITS.output + 4096 }));
          if (logs.stdout.includes('LOOP_ENTERED')) { entered = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!entered) throw new Error('Loop não confirmou entrada.');
        const enteredAt = performance.now();
        try {
          await json(api, 'POST', `/containers/${entry.id}/wait?condition=not-running`, { timeout: LIMITS.runawayMs });
          throw new Error('Loop terminou antes da supervisão.');
        } catch (error) { if (error.code !== 'DOCKER_TIMEOUT') throw error; }
        await inspectOwned(api, entry, repoRoot, report.round);
        await api('POST', `/v${API_VERSION}/containers/${entry.id}/kill?signal=SIGKILL`);
        await json(api, 'POST', `/containers/${entry.id}/wait?condition=not-running`);
        killedAfterMs = performance.now() - enteredAt;
      } else {
        const result = await json(api, 'POST', `/containers/${entry.id}/wait?condition=not-running`, { timeout: LIMITS.executionMs });
        if (result.StatusCode !== 0 || result.Error?.Message) throw new Error('Workload encerrou com erro.');
      }
      const durationMs = performance.now() - start;
      const final = await inspectOwned(api, entry, repoRoot, report.round);
      if (final.State.Running || final.State.OOMKilled || final.State.ExitCode !== (workload === 'runaway' ? 137 : 0)) throw new Error('Pós-condição de término inválida.');
      entry.phase = 'finished';
      let value = null;
      if (workload === 'valid') {
        const logs = decodeLogs(await api('GET', `/v${API_VERSION}/containers/${entry.id}/logs?stdout=true&stderr=true`, { maxBytes: LIMITS.output + 4096 }));
        if (logs.stderr) throw new Error('Workload produziu stderr inesperado.');
        value = decodeWorkload(logs.stdout);
        if (value.arch !== (arch === 'amd64' ? 'x64' : 'arm64')) throw new Error('Arquitetura do workload diverge do perfil.');
      }
      return { create_start_wait_ms: durationMs, killed_after_entry_ms: killedAfterMs, workload: value };
    } finally {
      await cleanupEntry(api, entry, repoRoot, report.round);
      await record(report);
    }
  }

  try {
    const cold = [];
    for (let index = 0; index < LIMITS.coldSamples; index++) cold.push(await sample());
    const runaway = await sample('runaway');
    const recovery = await sample();
    let cursor = 0;
    const concurrent = [];
    const start = performance.now();
    const workers = await Promise.allSettled(Array.from({ length: LIMITS.concurrency }, async () => {
      while (cursor < LIMITS.concurrentSamples) { cursor++; concurrent.push(await sample()); }
    }));
    const failure = workers.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (report.containers.some((entry) => entry.phase !== 'removed')) throw new Error('Limpeza própria pendente.');
    report.measurements = { cold, cold_create_start_wait_ms: summary(cold.map((value) => value.create_start_wait_ms)),
      warm_call_ms: summary(cold.flatMap((value) => value.workload.warm_call_ms)),
      runaway, recovery, concurrent, concurrent_total_ms: performance.now() - start };
    report.checks = [{ id: 'workload', passed: true }, { id: 'profile_effective', passed: true },
      { id: 'runaway_killed', passed: true }, { id: 'recovery', passed: recovery.workload.value === 41 },
      { id: 'cleanup_owned', passed: true }];
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.reason = error.message;
    report.measurements = null;
  }
  await record(report);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const cleanupRound = args[0] === '--cleanup' ? args[1] : null;
  if (cleanupRound) identity(RUNTIME_REPO_ROOT, cleanupRound, 0);
  if (cleanupRound ? args.length !== 2
    : args.length > 1 || (args.length && !['--check', '--pull', '--run'].includes(args[0]))) {
    throw new Error('Use --check, --pull, --run ou --cleanup UUID-da-rodada.');
  }
  const mode = (args[0] ?? '--check').slice(2);
  const context = await validateRuntimeWorkspace({ repoRoot: RUNTIME_REPO_ROOT,
    evidenceDir: join(RUNTIME_REPO_ROOT, '.superpowers/evidence/extensoes-bancada') });
  const sockets = [...new Set(['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')])];
  let api;
  const diagnostics = [];
  for (const socket of sockets) {
    const candidate = engineClient(socket);
    const result = await preflight(candidate);
    diagnostics.push({ socket, ...result });
    if (result.status === 'ready') { api = candidate; break; }
  }
  if (!api) {
    process.stdout.write(`${JSON.stringify({ id: 'container-comparison', status: 'blocked', mode,
      diagnostics, reason: 'API Docker indisponível; nenhum pull/create/start executado.', measurements: null }, null, 2)}\n`);
    return;
  }
  if (cleanupRound) {
    const file = join(context.evidenceDir, `container-${cleanupRound}.json`);
    const saved = await readJsonPlain(file);
    if (saved.round !== cleanupRound || saved.repo_root !== context.repoRoot
      || !Array.isArray(saved.containers) || saved.containers.length > 100) throw new Error('Journal não pertence a esta worktree/rodada.');
    for (const entry of saved.containers) {
      if (entry.name !== identity(context.repoRoot, cleanupRound, entry.index).name
        || (entry.id && !/^[a-f0-9]{64}$/.test(entry.id))) throw new Error('Journal contém identidade inválida.');
      await cleanupEntry(api, entry, context.repoRoot, cleanupRound);
    }
    await validateRuntimeWorkspace(context);
    await writeJsonAtomic(file, saved);
    process.stdout.write(`${JSON.stringify({ round: cleanupRound, containers: saved.containers }, null, 2)}\n`);
    if (saved.containers.some((entry) => entry.phase === 'cleanup_pending')) process.exitCode = 1;
    return;
  }
  let queue = Promise.resolve();
  const report = await executeProfile(api, { repoRoot: context.repoRoot, mode, record: (value) => {
    const snapshot = structuredClone(value);
    queue = queue.then(async () => {
      await validateRuntimeWorkspace(context);
      await writeJsonAtomic(join(context.evidenceDir, `container-${snapshot.round}.json`), snapshot);
    });
    return queue;
  } });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
