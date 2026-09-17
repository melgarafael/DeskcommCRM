import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeExecutablePaths } from './workspace.mjs';

const PROCESS_TIMEOUT_MS = 10_000;
const HOST_TIMEOUT_MS = 750;
const MAX_PROTOCOL_BYTES = 128 * 1024;
const CONCURRENCY = 2;
// Valores constantes: nenhuma credencial, PYTHONPATH ou variável do CRM herdada.
const CHILD_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' });

function execute(python, script, mode) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(python, ['-I', '-u', script, mode], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let killReason = null;
    let hostEnteredAt = null;
    let hostTimer;
    let markerBuffer = '';
    const kill = (reason) => {
      killReason ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('process_timeout'), PROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_PROTOCOL_BYTES) return kill('protocol_output_limit');
      stdout += chunk.toString('utf8');
      if (mode === 'host-hang' && hostEnteredAt === null) {
        markerBuffer += chunk.toString('utf8');
        const newline = markerBuffer.indexOf('\n');
        if (newline >= 0) {
          try {
            const marker = JSON.parse(markerBuffer.slice(0, newline));
            if (marker.event === 'host_entered' && marker.pid === child.pid) {
              hostEnteredAt = performance.now();
              hostTimer = setTimeout(() => kill('host_timeout'), HOST_TIMEOUT_MS);
            }
          } catch {
            kill('invalid_protocol');
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_PROTOCOL_BYTES) return kill('protocol_output_limit');
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(hostTimer);
      reject(error);
    });
    // Resolver apenas depois de exit + fechamento dos pipes, nunca no timeout.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hostTimer);
      let pidGone = false;
      try { process.kill(child.pid, 0); } catch (error) { pidGone = error.code === 'ESRCH'; }
      resolve({ code, signal, stdout, stderr, killReason, pidGone, duration_ms: performance.now() - start,
        host_elapsed_ms: hostEnteredAt === null ? null : performance.now() - hostEnteredAt });
    });
  });
}

function decode(result) {
  if (result.code !== 0 || result.signal || result.killReason) {
    throw new Error(`process_failed: code=${result.code}; signal=${result.signal}; reason=${result.killReason}; ${result.stderr.slice(0, 2000)}`);
  }
  return JSON.parse(result.stdout);
}

function summary(samples) {
  return { samples, n: samples.length, mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    min: Math.min(...samples), max: Math.max(...samples) };
}

async function dockerAvailability() {
  const candidates = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')];
  const observations = [];
  for (const socketPath of candidates) {
    try { await access(socketPath); } catch { continue; }
    const observation = await new Promise((resolve) => {
      const start = performance.now();
      const req = request({ socketPath, path: '/_ping', method: 'GET' }, (res) => {
        res.resume();
        finish(`HTTP ${res.statusCode}`);
      });
      const deadline = setTimeout(() => { req.destroy(); finish('timeout após 2000 ms'); }, 2000);
      let done = false;
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        resolve({ socketPath, result, duration_ms: performance.now() - start });
      }
      req.on('error', (error) => finish(error.code ?? error.name));
      req.end();
    });
    observations.push(observation);
  }
  const available = observations.some((item) => item.result === 'HTTP 200');
  return { status: 'not_run', daemon_status: available ? 'ready' : 'blocked', observations,
    reason: available
      ? 'Docker respondeu. Este ensaio mede Wasmtime; a execução em contêiner e suas evidências pertencem ao perfil separado runtime/container.'
      : 'Docker não respondeu nos sockets testados. Este ensaio mede Wasmtime; execute o perfil separado runtime/container quando o daemon estiver disponível.',
    profile: null, measurements: null };
}

export async function runProbe({ repoRoot, evidenceDir }) {
  // Rejeição de contexto acontece antes de iniciar subprocesso ou produzir relatório.
  const context = { repoRoot, evidenceDir };
  const { available } = await runtimeExecutablePaths(context);
  const run = async (mode) => {
    const paths = await runtimeExecutablePaths(context);
    if (!paths.available) throw new Error('Python próprio indisponível antes da execução.');
    return execute(paths.python, paths.script, mode);
  };
  const report = {
    id: 'runtime', status: 'blocked', environment: { platform: `${process.platform}-${process.arch}`, node: process.version },
    checks: [], measurements: {}, limitations: [
      'Bancada sintética: não mede integração ao CRM, RLS, broker de produção ou instalação em VPS.',
      'Wasm core sem WASI; não valida Component Model, WIT, SDK JavaScript ou pacote de extensão real.',
      'Memória linear limitada não é quota de RSS do processo. RSS e CPU são observações, sem contenção por cgroup nesta execução.',
      'O processo Python confiável acessa fixtures e biblioteca; o guest não recebe filesystem, rede, ambiente nem credenciais.',
      'A supervisão encerra o processo, mas não desfaz efeitos remotos já iniciados. Idempotência e cancelamento do broker real seguem pendentes.',
      'Parâmetros e medições são do ensaio, sem SLA de produto; carga curta não mede saturação nem noisy neighbor.',
    ],
  };
  if (!available) {
    report.limitations.push('Wasmtime indisponível: preparar evidenceDir/venv com wasmtime==48.0.0.');
    return report;
  }
  try {
    const suiteProcess = await run('suite');
    const suite = decode(suiteProcess);
    report.checks.push(...suite.checks);
    Object.assign(report.environment, suite.environment);
    report.checks.push({ id: 'version', name: 'Usar versão fixada do Wasmtime', passed: suite.environment.wasmtime === '48.0.0', observed: suite.environment.wasmtime });
    Object.assign(report.measurements, suite.measurements, { suite_process_ms: suiteProcess.duration_ms, limits: { ...suite.limits,
      process_timeout_ms: PROCESS_TIMEOUT_MS, host_timeout_ms: HOST_TIMEOUT_MS, protocol_output_bytes: MAX_PROTOCOL_BYTES, concurrency: CONCURRENCY } });
    const stuck = await run('host-hang');
    const recovery = decode(await run('valid'));
    report.checks.push({ id: 'host_timeout', name: 'Encerrar processo com chamada do host travada',
      passed: stuck.killReason === 'host_timeout' && stuck.signal === 'SIGKILL' && stuck.pidGone && recovery.value === 41,
      observed: { kill_reason: stuck.killReason, signal: stuck.signal, pid_gone: stuck.pidGone,
        host_elapsed_ms: stuck.host_elapsed_ms, recovery_value: recovery.value } });
    const cold = [];
    const coldInternal = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await run('valid');
      const parsed = decode(result);
      if (parsed.value !== 41) throw new Error('cold execution returned wrong value');
      cold.push(result.duration_ms);
      coldInternal.push(parsed.engine_compile_instantiate_call_ms);
    }
    report.measurements.cold_process_ms = summary(cold);
    report.measurements.cold_engine_compile_instantiate_call_ms = summary(coldInternal);
    const concurrent = [];
    let next = 0;
    let active = 0;
    let peakActive = 0;
    const parallelStart = performance.now();
    const workers = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
      while (next < 8) {
        next += 1;
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          const result = await run('valid');
          concurrent.push({ ...decode(result), process_ms: result.duration_ms });
        } finally { active -= 1; }
      }
    }));
    const failedWorker = workers.find((worker) => worker.status === 'rejected');
    if (failedWorker) throw failedWorker.reason;
    report.measurements.concurrent = { tasks: concurrent.length, maximum_active: peakActive,
      total_ms: performance.now() - parallelStart, process_ms: summary(concurrent.map((item) => item.process_ms)),
      process_rss_peak_bytes: concurrent.map((item) => item.rss_peak_bytes) };
    report.checks.push({ id: 'bounded_concurrency', name: 'Executar oito chamadas com no máximo dois processos',
      passed: concurrent.length === 8 && peakActive === CONCURRENCY && concurrent.every((item) => item.value === 41),
      observed: { tasks: concurrent.length, maximum_active: peakActive } });
    report.measurements.container_comparison = await dockerAvailability();
    report.limitations.push(report.measurements.container_comparison.reason);
    report.status = report.checks.every((check) => check.passed) ? 'passed' : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.checks.push({ id: 'unexpected_error', name: 'Executar a bancada sem erro inesperado', passed: false, observed: error.message });
  }
  return report;
}
