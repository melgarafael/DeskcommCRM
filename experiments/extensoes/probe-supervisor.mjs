import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment, readContext } from './common.mjs';

const ids = ['runtime', 'events', 'state'];
export class ProbeBusyError extends Error {}

async function ownedContext(context) {
  const owned = await readContext(context.repoRoot);
  if (owned.evidenceDir !== context.evidenceDir || owned.databaseUrl !== context.databaseUrl) {
    throw new Error('Contexto da execução não pertence à bancada.');
  }
  return owned;
}

export async function probeReservation(context) {
  const owned = await ownedContext(context);
  let handle;
  try {
    handle = await open(path.join(owned.evidenceDir, 'probe.lock'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1) throw new Error('Reserva não pertence à bancada.');
    const value = await handle.readFile('utf8');
    if (!value) return null;
    // Leitura durante a escrita ou supervisor interrompido: recusar conservadoramente.
    try {
      const reservation = JSON.parse(value);
      if (reservation.purpose !== 'extensions-probe-reservation' || reservation.repo_root !== owned.repoRoot
        || !ids.includes(reservation.id)) throw new Error('Reserva inválida.');
      return reservation.id;
    } catch { return 'unconfirmed'; }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

/** API interna importável para prova de processos; a porta HTTP nunca recebe comandos/caminhos. */
export async function prepareProbe(context, id, { timeoutMs = 60000 } = {}) {
  if (!ids.includes(id) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Prova inválida.');
  const owned = await ownedContext(context);
  const child = spawn('python3', ['-I', path.join(owned.repoRoot, 'experiments/extensoes/probe-supervisor.py'),
    owned.evidenceDir, owned.repoRoot, id, process.execPath,
    path.join(owned.repoRoot, 'experiments/extensoes/probe-supervisor-worker.mjs'), String(timeoutMs / 1000)], {
    cwd: owned.repoRoot, env: childEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdio[3].once('data', value => value.toString() === 'locked\n' ? resolve() : reject(new Error('Reserva inválida.')));
    child.once('close', code => reject(code === 73
      ? new ProbeBusyError('Há uma prova em andamento ou sem encerramento confirmado. Aguarde; se persistir, inspecione a reserva local.')
      : new Error('Não foi possível reservar a execução da bancada.')));
  });
  return child;
}

export function cancelProbe(child) {
  // ChildProcess guarda o filho criado aqui; nunca aceita PID vindo de disco/HTTP.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
