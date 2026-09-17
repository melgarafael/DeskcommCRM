import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runProbe } from './probe.mjs';
import { RUNTIME_REPO_ROOT, validateRuntimeWorkspace, writeRuntimeReport } from './workspace.mjs';

if (process.argv.length > 2) throw new Error('verify não aceita destino alternativo de evidência.');
const { repoRoot, evidenceDir } = await validateRuntimeWorkspace({ repoRoot: RUNTIME_REPO_ROOT,
  evidenceDir: join(RUNTIME_REPO_ROOT, '.superpowers/evidence/extensoes-bancada') });
const report = await runProbe({ repoRoot, evidenceDir });
await writeRuntimeReport({ repoRoot, evidenceDir }, report);
assert.equal(report.id, 'runtime');
assert.equal(report.status, 'passed', JSON.stringify(report.checks.filter((check) => !check.passed)));
for (const id of ['valid', 'cross_org', 'missing_grant', 'filesystem', 'network', 'fuel', 'memory_initial', 'memory',
  'output', 'output_cumulative', 'output_at_limit', 'host_timeout', 'bounded_concurrency', 'version']) {
  assert.ok(report.checks.some((check) => check.id === id && check.passed), id);
}
assert.equal(report.measurements.cold_process_ms.n, 5);
assert.equal(report.measurements.warm_call_ms.n, 50);
assert.equal(report.measurements.concurrent.tasks, 8);
assert.equal(report.measurements.concurrent.maximum_active, 2);
assert.equal(report.measurements.container_comparison.status, 'not_run');
process.stdout.write(`${JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(evidenceDir, 'runtime-report.json') })}\n`);
