/** Gera artefato privado em fluxo: o histórico ultrapassa o limite de uma string V8. */
import { readFile, readdir, chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { transform } from './transform.mjs';
import { transformArchive } from './transform-archive.mjs';
import { SOURCE_WORKSPACE } from './core.mjs';

process.umask(0o077);
const [directory, mediaPath, outputPath] = process.argv.slice(2);
if (!directory || !mediaPath || !outputPath) throw new Error('Informe diretório extraído, manifesto de mídia e saída privada');
const tables = {};
const sourceManifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (sourceManifest.workspace_id !== SOURCE_WORKSPACE || !sourceManifest.cutoff) throw new Error('Manifesto de origem inválido');
for (const name of await readdir(directory)) {
  if (!/^[a-z_]+\.ndjson$/.test(name)) continue;
  tables[name.replace('.ndjson', '')] = (await readFile(resolve(directory, name), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
}
const media = JSON.parse(await readFile(mediaPath, 'utf8'));
const result = transform(tables, media);
const archive = transformArchive(tables, result.mapping, media);
const output = { ...result.tables, ...archive };
function* rawChunks() {
  yield '{'; let separator = '';
  for (const [table, rows] of Object.entries(output)) {
    yield separator + JSON.stringify(table) + ':['; separator = ',';
    for (let index = 0; index < rows.length; index++) yield (index ? ',' : '') + JSON.stringify(rows[index]);
    yield ']';
  }
  yield '}';
}
const hash = createHash('sha256');
function* chunks() { for (const chunk of rawChunks()) { hash.update(chunk); yield chunk; } }
await pipeline(Readable.from(chunks()), createWriteStream(outputPath, { mode: 0o600 }));
await chmod(outputPath, 0o600);
await writeFile(outputPath + '.manifest.json', JSON.stringify({ source_workspace_id: SOURCE_WORKSPACE, batch_id: result.batch_id,
  source_cutoff: sourceManifest.cutoff, native_sha256: hash.digest('hex'),
  tables: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, { count: rows.length }])),
  native_counts: Object.fromEntries(Object.entries(output).map(([table, rows]) => [table, rows.length])),
  snapshot_union_changes: sourceManifest.snapshot_union_changes ?? {},
}, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify({ prepared: true, production_imported: false, counts: Object.fromEntries(Object.entries(output).map(([table, rows]) => [table, rows.length])) }) + '\n');
