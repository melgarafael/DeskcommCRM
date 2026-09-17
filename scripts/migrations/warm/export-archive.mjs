import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceReader, redactCredentials, digestRows, dependentTables } from './archive.mjs';
import { SOURCE_WORKSPACE } from './core.mjs';

const directory = process.argv[2], compareDirectory = process.argv[3];
if (!directory?.startsWith('/')) throw new Error('Informe diretório absoluto novo');
process.umask(0o077);
const dir = resolve(directory);
await mkdir(dir, { mode: 0o700 });
const previous = compareDirectory ? JSON.parse(await readFile(resolve(compareDirectory, 'manifest.json'), 'utf8')) : null;
if (previous && previous.workspace_id !== SOURCE_WORKSPACE) throw new Error('Comparação de outro workspace');
const cutoff = previous?.cutoff ?? new Date().toISOString();
const manifest = { workspace_id: SOURCE_WORKSPACE, started_at: new Date().toISOString(), cutoff,
  consistent_snapshot: false, production_import_allowed: false, contains_binary_media: false,
  purpose: 'isolated-rehearsal', tables: {}, omitted_credentials: {}, excluded_global_tables: [], comparison: null };
try {
  const reader = sourceReader({url:process.env.SUPABASE_URL, key:process.env.SUPABASE_SERVICE_ROLE_KEY});
  const schema = await reader.schema(), data = {};
  const definitions = schema.definitions;
  if (!definitions?.contacts?.properties?.workspace_id) throw new Error('Catálogo inesperado');
  async function extract(table, filter, allowed) {
    const columns = Object.keys(definitions[table]?.properties ?? {});
    if (!columns.length) throw new Error(`Tabela ausente: ${table}`);
    const rows = await reader.rows({table, columns, filter, allowed: [...new Set(allowed)], cutoff,
      keyColumn: columns.includes('id') ? 'id' : 'workspace_id'});
    data[table] = rows;
    const omitted = {};
    const clean = rows.map(row => redactCredentials(row, omitted));
    const filename = resolve(dir, `${table}.ndjson`);
    await writeFile(filename + '.partial', clean.map(row => JSON.stringify(row) + '\n').join(''), {flag:'wx',mode:0o600});
    await rename(filename + '.partial', filename);
    manifest.tables[table] = { count: clean.length, sha256: digestRows(clean), scope_column: filter, columns,
      created_at_cutoff_applied: columns.includes('created_at') };
    if (Object.keys(omitted).length) manifest.omitted_credentials[table] = omitted;
    process.stdout.write(JSON.stringify({table, count:clean.length}) + '\n');
  }
  for (const [table, definition] of Object.entries(definitions).sort(([a],[b])=>a.localeCompare(b))) {
    if (definition.properties?.workspace_id) await extract(table, 'workspace_id', [SOURCE_WORKSPACE]);
  }
  for (const [table, filter, parent, field] of dependentTables) {
    const ids = parent ? (data[parent] ?? []).map(row=>row[field]).filter(Boolean) : [SOURCE_WORKSPACE];
    await extract(table, filter, ids);
  }
  manifest.excluded_global_tables = Object.keys(definitions).filter(table=>!manifest.tables[table]).map(table=>({table,reason:'Tabela global, credencial ou operação de plataforma sem propriedade comprovada do workspace; não extraída.'}));
  if (previous) {
    const tables = new Set([...Object.keys(previous.tables), ...Object.keys(manifest.tables)]);
    const differences = [...tables].filter(table => previous.tables[table]?.sha256 !== manifest.tables[table]?.sha256)
      .map(table=>({table,before:previous.tables[table]?.count??null,after:manifest.tables[table]?.count??null}));
    manifest.comparison = {same_cutoff:true, differences, equal: differences.length===0,
      meaning:'Duas leituras equivalentes não provam snapshot transacional nem substituem delta final.'};
  }
  manifest.completed_at = new Date().toISOString();
  await writeFile(resolve(dir,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({completed:true,tables:Object.keys(manifest.tables).length,comparison:manifest.comparison})+'\n');
} catch(error) {
  await writeFile(resolve(dir,'FAILED'), new Date().toISOString(), {mode:0o600});
  process.stderr.write(error.message+'\n');process.exitCode=1;
}
