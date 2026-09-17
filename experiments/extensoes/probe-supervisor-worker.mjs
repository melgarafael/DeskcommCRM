import { fstatSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readContext, readJsonPlain } from './common.mjs';

const probes = {
  runtime: () => import('./runtime/probe.mjs'),
  events: () => import('./events/probe.mjs'),
  state: () => import('./state/probe.mjs'),
};
const id = process.argv[2];
if (!Object.hasOwn(probes, id)) throw new Error('Experimento desconhecido.');
const context = await readContext(fileURLToPath(new URL('../../', import.meta.url)));
// Entrada privada: só o supervisor transmite o descritor já reservado pelo SO.
const inherited = process.argv[3];
if (!/^[0-9]+$/.test(inherited ?? '')) throw new Error('Execute pela CLI runner.mjs ou pelo console.');
const lockFile = path.join(context.evidenceDir, 'probe.lock');
const held = fstatSync(Number(inherited));
const disk = lstatSync(lockFile);
const reservation = await readJsonPlain(lockFile);
if (!held.isFile() || !disk.isFile() || held.dev !== disk.dev || held.ino !== disk.ino
  || reservation.purpose !== 'extensions-probe-reservation' || reservation.repo_root !== context.repoRoot
  || reservation.id !== id) throw new Error('Descritor da reserva inválido.');
const { runProbe } = await probes[id]();
const report = await runProbe(context);
if (report.id !== id || !['passed', 'failed', 'blocked'].includes(report.status)
  || !Array.isArray(report.checks) || !Array.isArray(report.limitations)
  || (report.status === 'passed' && (!report.checks.length || report.checks.some(check => !check.passed)))) {
  throw new Error('O relatório do experimento não satisfaz o contrato.');
}
process.stdout.write(`${JSON.stringify(report)}\n`);
