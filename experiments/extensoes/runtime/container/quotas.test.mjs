import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig } from './profile.mjs';
import { QUOTA_SOURCES } from './quota-workloads.mjs';
import { executeQuotas, validateQuotaResult } from './quotas.mjs';

function logs(value, stderr = '') {
  const frame = (text, stream) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([frame(typeof value === 'string' ? value : JSON.stringify(value), 1), frame(stderr, 2)]);
}
const exited = { Running: false, ExitCode: 0, OOMKilled: false };

test('quotas mantêm exatamente o perfil limitado do benchmark', () => {
  const baseline = createConfig({ arch: 'arm64', labels: {} });
  for (const mode of Object.keys(QUOTA_SOURCES)) {
    const config = createConfig({ arch: 'arm64', labels: {}, mode });
    assert.deepEqual(config.HostConfig, baseline.HostConfig);
    assert.deepEqual(config.Env, baseline.Env);
    assert.equal(config.Image, baseline.Image);
    assert.equal(config.User, baseline.User);
    assert.equal(config.Cmd[0], '--max-old-space-size=32');
  }
});

test('filesystem exige EROFS com controle /tmp; EACCES incidental não aprova', () => {
  const valid = { positive_tmp: true, rootfs_error: 'EROFS' };
  assert.deepEqual(validateQuotaResult('quota_fs', exited, logs(valid)), valid);
  assert.throws(() => validateQuotaResult('quota_fs', exited, logs({ ...valid, rootfs_error: 'EACCES' })));
  assert.throws(() => validateQuotaResult('quota_fs', exited, logs({ ...valid, positive_tmp: false })));
});

test('rede exige loopback funcional e rota negada; timeout não aprova', () => {
  const valid = { loopback_allowed: true, external_error: 'ENETUNREACH' };
  assert.deepEqual(validateQuotaResult('quota_network', exited, logs(valid)), valid);
  assert.throws(() => validateQuotaResult('quota_network', exited, logs({ ...valid, external_error: 'ETIMEDOUT' })));
  assert.throws(() => validateQuotaResult('quota_network', exited, logs({ ...valid, loopback_allowed: false })));
});

test('memória exige OOMKilled/137 com Buffer externo e cgroup correto; heap V8 não aprova', () => {
  const marker = { stage: 'external_buffer_fill', memory_max: 134217728 };
  const oom = { ...exited, ExitCode: 137, OOMKilled: true };
  assert.equal(validateQuotaResult('quota_memory', oom, logs(marker)).oom_killed, true);
  assert.throws(() => validateQuotaResult('quota_memory', { ...oom, OOMKilled: false }, logs(marker)));
  assert.throws(() => validateQuotaResult('quota_memory', { ...oom, ExitCode: 134 }, logs(marker, 'JavaScript heap out of memory')));
  assert.throws(() => validateQuotaResult('quota_memory', oom, logs({ ...marker, memory_max: 268435456 })));
});

test('pids exige EAGAIN ao atingir cgroup32 com spawn positivo; falta de binário não aprova', () => {
  const valid = { positive_spawns: 20, error: 'EAGAIN', pids_max: 32, pids_current_at_failure: 32, pids_current_after_cleanup: 12 };
  assert.deepEqual(validateQuotaResult('quota_pids', exited, logs(valid)), valid);
  for (const invalid of [{ error: 'ENOENT' }, { error: 'ENOMEM' }, { positive_spawns: 0 }, { pids_current_at_failure: 10 }]) {
    assert.throws(() => validateQuotaResult('quota_pids', exited, logs({ ...valid, ...invalid })));
  }
});

test('saída exige rejeição pelo limite e processo válido, não frame truncado ou OOM', () => {
  const payload = logs('X'.repeat(65537) + '\n');
  assert.equal(validateQuotaResult('quota_output', exited, payload).actual_output_bytes, 65538);
  assert.throws(() => validateQuotaResult('quota_output', exited, logs('curto')));
  assert.throws(() => validateQuotaResult('quota_output', exited, payload.subarray(1)));
  assert.throws(() => validateQuotaResult('quota_output', { ...exited, ExitCode: 137, OOMKilled: true }, payload));
});

test('sem daemon a prova de quotas fica blocked e não tenta mutação', async () => {
  const calls = [];
  const report = await executeQuotas(async (method, path) => {
    calls.push([method, path]); throw new Error('offline sintético');
  }, { repoRoot: '/synthetic/worktree' });
  assert.equal(report.status, 'blocked');
  assert.equal(report.measurements, null);
  assert.deepEqual(calls, [['GET', '/_ping']]);
});
