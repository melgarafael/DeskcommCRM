import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOwnedWorkspace } from '../common.mjs';

export const RUNTIME_REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const EVIDENCE_PARTS = ['.superpowers', 'evidence', 'extensoes-bancada'];

async function inspectPath(root, target, { missing = false, file = false } = {}) {
  const suffix = relative(root, target);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || resolve(root, suffix) !== target) {
    throw new Error('Destino fora da área exclusiva do runtime.');
  }
  let cursor = root;
  const parts = suffix ? suffix.split(sep) : [];
  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) cursor = join(cursor, parts[index - 1]);
    let info;
    try { info = await lstat(cursor); } catch (error) {
      if (missing && error.code === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('Caminho simbólico recusado pelo runtime.');
    const finalFile = file && index === parts.length;
    if (finalFile ? !info.isFile() : !info.isDirectory()) throw new Error('Tipo de caminho inválido para o runtime.');
  }
  return true;
}

/** A âncora vem do módulo instalado; o chamador não pode substituí-la. */
export async function validateRuntimeWorkspace(context) {
  const root = RUNTIME_REPO_ROOT;
  if (resolve(context.repoRoot) !== root || await realpath(root) !== root) {
    throw new Error('Raiz do runtime não corresponde à worktree deste módulo.');
  }
  const expected = join(root, ...EVIDENCE_PARTS);
  if (resolve(context.evidenceDir) !== expected) throw new Error('Destino diferente da área exclusiva do runtime.');
  // Antes de ensureOwnedWorkspace criar marcador/diretórios, recusa desvios existentes.
  await inspectPath(root, expected, { missing: true });
  await inspectPath(root, join(expected, 'owner.json'), { missing: true, file: true });
  await inspectPath(root, join(expected, 'runtime-report.json'), { missing: true, file: true });
  const evidenceDir = await ensureOwnedWorkspace(root);
  if (evidenceDir !== expected) throw new Error('Área da bancada não corresponde à raiz do runtime.');
  await inspectPath(root, evidenceDir);
  await inspectPath(evidenceDir, join(evidenceDir, 'owner.json'), { file: true });
  await inspectPath(evidenceDir, join(evidenceDir, 'runtime-report.json'), { missing: true, file: true });
  return { repoRoot: root, evidenceDir };
}

export async function runtimeExecutablePaths(context) {
  const owned = await validateRuntimeWorkspace(context);
  const python = join(owned.evidenceDir, 'venv/bin/python');
  const script = join(owned.repoRoot, 'experiments/extensoes/runtime/wasm_probe.py');
  await inspectPath(owned.repoRoot, script, { file: true });
  const available = await inspectPath(owned.evidenceDir, python, { file: true, missing: true });
  return { ...owned, python, script, available };
}

/** Recusa link no destino; arquivo temporário exclusivo, sem seguir links existentes. */
export async function writeRuntimeReport(context, report) {
  const owned = await validateRuntimeWorkspace(context);
  const output = join(owned.evidenceDir, 'runtime-report.json');
  await inspectPath(owned.evidenceDir, output, { missing: true, file: true });
  const temporary = join(owned.evidenceDir, `.runtime-report-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await validateRuntimeWorkspace(owned);
    await inspectPath(owned.evidenceDir, output, { missing: true, file: true });
    await rename(temporary, output);
    const directory = await open(dirname(output), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return output;
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
