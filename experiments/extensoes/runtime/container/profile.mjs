import { createHash } from 'node:crypto';
import { WORKLOAD_SOURCE } from './workload.mjs';
import { QUOTA_SOURCES } from './quota-workloads.mjs';

// Metadados consultados no Registry oficial em 2026-09-14; nenhum pull local.
export const IMAGE = Object.freeze({
  tag: 'node:22.22.3-bookworm-slim',
  index: 'sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752',
  amd64: 'sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644',
  arm64: 'sha256:111d09056e51bb52d1bfca06a3e73476d6022b156dc4c36c5379503cd307660b',
});
export const LIMITS = Object.freeze({ cpu: 0.5, memory: 128 * 1024 * 1024, pids: 32,
  tmpfs: 8 * 1024 * 1024, output: 64 * 1024, executionMs: 10_000, runawayMs: 1500,
  requestMs: 5000, preflightMs: 2000, concurrency: 2, coldSamples: 5, concurrentSamples: 8 });

export function platformForDaemon(arch) {
  if (['aarch64', 'arm64'].includes(arch)) return 'arm64';
  if (['x86_64', 'amd64'].includes(arch)) return 'amd64';
  throw new Error('Arquitetura do daemon fora dos dois perfis fixados.');
}

export function imageReference(arch) {
  if (!['amd64', 'arm64'].includes(arch)) throw new Error('Plataforma não admitida.');
  return `docker.io/library/node@${IMAGE[arch]}`;
}

export function identity(repoRoot, round, index) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(round)
    || !Number.isInteger(index) || index < 0 || index > 100) throw new Error('Identidade de rodada inválida.');
  const owner = createHash('sha256').update(repoRoot).digest('hex');
  return { name: `extbench-${round}-${index}`, labels: {
    'org.extensions-bench.purpose': 'executor-comparison',
    'org.extensions-bench.owner': owner,
    'org.extensions-bench.round': round,
  } };
}

export function createConfig({ arch, labels, mode = 'valid' }) {
  if (!['valid', 'runaway', ...Object.keys(QUOTA_SOURCES)].includes(mode)) throw new Error('Workload não admitido.');
  return {
    Image: imageReference(arch), User: '65534:65534', WorkingDir: '/tmp',
    Entrypoint: ['/usr/local/bin/node'], Cmd: ['--max-old-space-size=32', '-e', QUOTA_SOURCES[mode] ?? WORKLOAD_SOURCE, mode],
    Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C', 'HOME=/tmp', 'NODE_OPTIONS='],
    Labels: labels, AttachStdout: true, AttachStderr: true, Tty: false,
    OpenStdin: false, NetworkDisabled: true,
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'], Privileged: false,
      NanoCpus: LIMITS.cpu * 1e9, Memory: LIMITS.memory, MemorySwap: LIMITS.memory,
      PidsLimit: LIMITS.pids, Binds: [], Mounts: [], PublishAllPorts: false,
      Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${LIMITS.tmpfs},mode=1777` },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
      LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } },
    },
  };
}

export function assertOwnedContainer(container, expected, id) {
  if (container.Id !== id || container.Name !== `/${expected.name}`
    || Object.entries(expected.labels).some(([key, value]) => container.Config?.Labels?.[key] !== value)) {
    throw new Error('Contêiner não pertence a esta rodada; operação recusada.');
  }
}

export function assertEffectiveProfile(container, config) {
  for (const key of ['User', 'Entrypoint', 'Cmd']) {
    if (JSON.stringify(container.Config[key]) !== JSON.stringify(config[key])) throw new Error(`Perfil efetivo divergente: ${key}`);
  }
  for (const key of ['NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Privileged',
    'NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit', 'Tmpfs', 'RestartPolicy']) {
    if (JSON.stringify(container.HostConfig[key]) !== JSON.stringify(config.HostConfig[key])) throw new Error(`Quota/perfil não aplicado: ${key}`);
  }
  if (container.Mounts?.some((mount) => mount.Type !== 'tmpfs') || container.HostConfig.Binds?.length
    || container.HostConfig.CapAdd?.length || container.HostConfig.Devices?.length) throw new Error('Montagem/privilégio não admitido.');
  const logging = container.HostConfig.LogConfig;
  if (logging?.Type !== config.HostConfig.LogConfig.Type
    || Object.entries(config.HostConfig.LogConfig.Config).some(([key, value]) => logging.Config?.[key] !== value)) {
    throw new Error('Perfil de logs não aplicado.');
  }
}
