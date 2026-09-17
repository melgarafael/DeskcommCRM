import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ensureOwnedWorkspace } from '../common.mjs';
import { RUNTIME_REPO_ROOT } from './workspace.mjs';

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'extensions-runtime-f5-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'own-worktree');
  const foreign = join(temporary, 'other-worktree');
  const runtime = join(root, 'experiments/extensoes/runtime');
  await mkdir(runtime, { recursive: true });
  await mkdir(foreign);
  // Cópias idênticas do código: a raiz confiável deriva da localização do módulo,
  // sem parâmetro de teste capaz de trocar a âncora na API real.
  for (const name of ['workspace.mjs', 'probe.mjs', 'verify.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(runtime, name));
  }
  await writeFile(join(runtime, '../common.mjs'), `export { ensureOwnedWorkspace } from ${JSON.stringify(new URL('../common.mjs', import.meta.url).href)};\n`);
  await writeFile(join(runtime, 'wasm_probe.py'), '# arquivo sintético; não executar\n');
  const ownEvidence = await ensureOwnedWorkspace(root);
  const foreignEvidence = await ensureOwnedWorkspace(foreign);
  const sentinel = join(foreignEvidence, 'runtime-report.json');
  const executed = join(foreignEvidence, 'executed.txt');
  await writeFile(sentinel, 'SENTINELA-EXTERNA');
  await mkdir(join(foreignEvidence, 'venv/bin'), { recursive: true });
  const foreignPython = join(foreignEvidence, 'venv/bin/python');
  await writeFile(foreignPython, `#!/bin/sh\nprintf EXECUTADO > '${executed}'\nexit 99\n`, { mode: 0o700 });
  const guard = await import(pathToFileURL(join(runtime, 'workspace.mjs')).href);
  const { runProbe } = await import(pathToFileURL(join(runtime, 'probe.mjs')).href);
  const context = { repoRoot: root, evidenceDir: ownEvidence };
  return { root, runtime, ownEvidence, foreign, foreignEvidence, foreignPython, context, guard, runProbe,
    async untouched() {
      assert.equal(await readFile(sentinel, 'utf8'), 'SENTINELA-EXTERNA');
      await assert.rejects(lstat(executed), { code: 'ENOENT' });
    } };
}

test('F5: probe recusa evidência externa e raiz de outra worktree antes de executar', async (t) => {
  const f = await fixture(t);
  for (const context of [
    { ...f.context, evidenceDir: f.foreignEvidence },
    { repoRoot: f.foreign, evidenceDir: f.foreignEvidence },
    { ...f.context, evidenceDir: join(f.ownEvidence, 'alternative') },
  ]) {
    await assert.rejects(f.runProbe(context), /worktree|exclusiva/);
    await assert.rejects(f.guard.writeRuntimeReport(context, { status: 'blocked' }), /worktree|exclusiva/);
  }
  await f.untouched();
});

test('F5: CLI rejeita argumento alternativo e preserva relatório externo', async (t) => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [join(f.runtime, 'verify.mjs'), f.foreignEvidence], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não aceita destino alternativo/);
  await f.untouched();
});

test('F5: marcador de outra worktree é recusado antes da execução e escrita', async (t) => {
  const f = await fixture(t);
  await copyFile(join(f.foreignEvidence, 'owner.json'), join(f.ownEvidence, 'owner.json'));
  await assert.rejects(f.runProbe(f.context), /outra worktree/);
  await assert.rejects(f.guard.writeRuntimeReport(f.context, {}), /outra worktree/);
  await f.untouched();
});

for (const segment of ['.superpowers', '.superpowers/evidence', '.superpowers/evidence/extensoes-bancada']) {
  test(`F5: recusa symlink de diretório em ${segment}`, async (t) => {
    const f = await fixture(t);
    const target = join(f.root, segment);
    await rm(target, { recursive: true });
    await symlink(f.foreignEvidence, target);
    await assert.rejects(f.runProbe(f.context), /simbólico/);
    await assert.rejects(f.guard.writeRuntimeReport(f.context, {}), /simbólico/);
    await f.untouched();
  });
}

for (const segment of ['venv', 'venv/bin', 'venv/bin/python']) {
  test(`F5: recusa symlink do executável em ${segment}`, async (t) => {
    const f = await fixture(t);
    const segments = segment.split('/');
    await mkdir(join(f.ownEvidence, ...segments.slice(0, -1)), { recursive: true });
    await symlink(join(f.foreignEvidence, segment), join(f.ownEvidence, segment));
    await assert.rejects(f.runProbe(f.context), /simbólico/);
    await f.untouched();
  });
}

test('F5: recusa marcador simbólico', async (t) => {
  const f = await fixture(t);
  await rm(join(f.ownEvidence, 'owner.json'));
  await symlink(join(f.foreignEvidence, 'owner.json'), join(f.ownEvidence, 'owner.json'));
  await assert.rejects(f.runProbe(f.context), /simbólico/);
  await assert.rejects(f.guard.writeRuntimeReport(f.context, {}), /simbólico/);
  await f.untouched();
});

test('F5: recusa saída simbólica antes mesmo de constatar venv ausente', async (t) => {
  const f = await fixture(t);
  await symlink(join(f.foreignEvidence, 'runtime-report.json'), join(f.ownEvidence, 'runtime-report.json'));
  await assert.rejects(f.runProbe(f.context), /simbólico/);
  await assert.rejects(f.guard.writeRuntimeReport(f.context, { status: 'blocked' }), /simbólico/);
  await f.untouched();
});

test('F5: venv ausente gera blocked somente na área própria; escrita atômica substitui relatório próprio', async (t) => {
  const f = await fixture(t);
  const report = await f.runProbe(f.context);
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.length, 0);
  const output = join(f.ownEvidence, 'runtime-report.json');
  await writeFile(output, 'ANTERIOR-PRÓPRIO');
  const inode = (await lstat(output)).ino;
  assert.equal(await f.guard.writeRuntimeReport(f.context, report), output);
  assert.notEqual((await lstat(output)).ino, inode);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'blocked');
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.equal((await readdir(f.ownEvidence)).some((name) => name.endsWith('.tmp')), false);
  await f.untouched();
});

test('F5: API instalada recusa raiz sintética sem executar seu Python', async (t) => {
  const f = await fixture(t);
  const { runProbe } = await import('./probe.mjs');
  assert.notEqual(f.foreign, RUNTIME_REPO_ROOT);
  await assert.rejects(runProbe({ repoRoot: f.foreign, evidenceDir: f.foreignEvidence }), /worktree/);
  await f.untouched();
});
