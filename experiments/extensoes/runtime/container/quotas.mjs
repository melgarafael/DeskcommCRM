import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_REPO_ROOT, validateRuntimeWorkspace } from '../workspace.mjs';
import { writeJsonAtomic } from '../../common.mjs';
import { API_VERSION, engineClient, json, preflight } from './engine.mjs';
import { IMAGE, LIMITS, assertEffectiveProfile, assertOwnedContainer, createConfig, identity,
  imageReference, platformForDaemon } from './profile.mjs';
import { cleanupEntry } from './runner.mjs';
import { decodeLogs } from './workload.mjs';
import { QUOTA_SOURCES } from './quota-workloads.mjs';

export function validateQuotaResult(mode, state, rawLogs) {
  if (state.Running) throw new Error('Processo da prova ainda está em execução.');
  if (mode === 'quota_output') {
    assert.equal(state.ExitCode, 0);
    assert.equal(state.OOMKilled, false);
    let failure;
    try { decodeLogs(rawLogs, LIMITS.output); } catch (error) { failure = error.message; }
    assert.equal(failure, 'Saída do contêiner excedeu o limite.');
    // Decode de controle dentro de teto finito confirma comprimento real e ausência de stderr.
    const boundedControl = decodeLogs(rawLogs, LIMITS.output + 4096);
    assert.equal(boundedControl.stderr, '');
    assert.equal(Buffer.byteLength(boundedControl.stdout), 65538);
    return { reader_error: failure, actual_output_bytes: 65538, reader_limit_bytes: LIMITS.output };
  }
  const logs = decodeLogs(rawLogs, LIMITS.output);
  if (mode === 'quota_memory') {
    assert.equal(state.ExitCode, 137);
    assert.equal(state.OOMKilled, true);
    assert.equal(logs.stderr, '');
    const marker = JSON.parse(logs.stdout);
    assert.deepEqual(marker, { stage: 'external_buffer_fill', memory_max: LIMITS.memory });
    return { ...marker, exit_code: 137, oom_killed: true, allocation: 'Buffer.alloc preenchido, fora do heap V8' };
  }
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  assert.equal(logs.stderr, '');
  const output = JSON.parse(logs.stdout);
  if (mode === 'quota_fs') {
    assert.equal(output.positive_tmp, true);
    assert.equal(output.rootfs_error, 'EROFS');
  } else if (mode === 'quota_network') {
    assert.equal(output.loopback_allowed, true);
    assert.ok(['ENETUNREACH', 'EHOSTUNREACH'].includes(output.external_error));
  } else if (mode === 'quota_pids') {
    assert.ok(Number.isInteger(output.positive_spawns) && output.positive_spawns > 0 && output.positive_spawns < LIMITS.pids);
    assert.equal(output.error, 'EAGAIN');
    assert.equal(output.pids_max, LIMITS.pids);
    assert.equal(output.pids_current_at_failure, LIMITS.pids);
    assert.ok(output.pids_current_after_cleanup > 0 && output.pids_current_after_cleanup < LIMITS.pids);
  } else throw new Error('Prova de quota não admitida.');
  return output;
}

export async function executeQuotas(api, { repoRoot, record = async () => {} }) {
  const report = { id: 'container-quotas', round: randomUUID(), repo_root: repoRoot,
    status: 'blocked', preflight: await preflight(api), containers: [], checks: [], measurements: null,
    profile: { image: IMAGE, limits: LIMITS }, limitations: [
      'Cinco ataques sintéticos sequenciais; não medem segurança completa do runtime, egress concedido, side channels ou carga sustentada.',
      'CPU declarada/inspecionada em 0,5; este ensaio não mede enforcement da quota de CPU.',
      'Node Linux arm64 na VM Docker Desktop; sem equivalência com Wasm sem WASI, broker do CRM ou VPS amd64.',
    ] };
  await record(report);
  if (report.preflight.status !== 'ready') return report;
  const arch = platformForDaemon(report.preflight.version.Arch);
  const reference = imageReference(arch);
  const image = await json(api, 'GET', `/images/${encodeURIComponent(reference)}/json`);
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, arch);
  assert.ok(image.RepoDigests.some((digest) => digest.endsWith(`@${IMAGE[arch]}`)));
  report.profile.reference = reference;
  report.profile.local_image_id = image.Id;
  for (const [index, mode] of Object.keys(QUOTA_SOURCES).entries()) {
    const expected = identity(repoRoot, report.round, index);
    const entry = { index, name: expected.name, mode, phase: 'planned' };
    report.containers.push(entry);
    await record(report);
    const config = createConfig({ arch, labels: expected.labels, mode });
    async function inspect() {
      const actual = await json(api, 'GET', `/containers/${entry.id}/json`);
      assertOwnedContainer(actual, expected, entry.id);
      return actual;
    }
    try {
      entry.phase = 'create_uncertain';
      await record(report);
      let created;
      try {
        created = await json(api, 'POST', `/containers/create?${new URLSearchParams({ name: entry.name, platform: `linux/${arch}` })}`, { body: config });
      } catch (error) { if (error.status === 409) entry.phase = 'name_conflict'; throw error; }
      assert.match(created.Id, /^[a-f0-9]{64}$/);
      entry.id = created.Id;
      entry.phase = 'created';
      await record(report);
      const effective = await inspect();
      assertEffectiveProfile(effective, config);
      report.profile.effective ??= { User: effective.Config.User, HostConfig: effective.HostConfig, Mounts: effective.Mounts };
      await api('POST', `/v${API_VERSION}/containers/${entry.id}/start`);
      entry.phase = 'started';
      await record(report);
      const exit = await json(api, 'POST', `/containers/${entry.id}/wait?condition=not-running`, { timeout: LIMITS.executionMs });
      const final = await inspect();
      assert.equal(exit.StatusCode, final.State.ExitCode);
      entry.phase = 'finished';
      const logs = await api('GET', `/v${API_VERSION}/containers/${entry.id}/logs?stdout=true&stderr=true`, { maxBytes: LIMITS.output + 4096 });
      const observed = validateQuotaResult(mode, final.State, logs);
      report.checks.push({ id: mode, passed: true, observed,
        state: { Running: final.State.Running, ExitCode: final.State.ExitCode, OOMKilled: final.State.OOMKilled } });
    } catch (error) {
      report.checks.push({ id: mode, passed: false, observed: error.message });
    } finally {
      await cleanupEntry(api, entry, repoRoot, report.round);
      await record(report);
    }
    if (entry.phase !== 'removed') break;
  }
  report.status = report.checks.length === Object.keys(QUOTA_SOURCES).length
    && report.checks.every((check) => check.passed)
    && report.containers.every((entry) => entry.phase === 'removed') ? 'passed' : 'failed';
  await record(report);
  return report;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('A prova de quotas não aceita argumentos.');
  const context = await validateRuntimeWorkspace({ repoRoot: RUNTIME_REPO_ROOT,
    evidenceDir: join(RUNTIME_REPO_ROOT, '.superpowers/evidence/extensoes-bancada') });
  const report = await executeQuotas(engineClient('/var/run/docker.sock'), { repoRoot: context.repoRoot,
    record: async (value) => {
      await validateRuntimeWorkspace(context);
      await writeJsonAtomic(join(context.evidenceDir, `container-${value.round}.json`), value);
    } });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
