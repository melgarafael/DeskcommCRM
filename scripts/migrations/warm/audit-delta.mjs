/** Mede mudanças após o corte sem imprimir cadastros, conteúdo ou credenciais. */
import { SOURCE_HOST, SOURCE_WORKSPACE } from './core.mjs';
const cutoff = process.argv[2];
if (!cutoff || Number.isNaN(Date.parse(cutoff))) throw new Error('Corte inválido');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key || new URL(url).origin !== `https://${SOURCE_HOST}`) throw new Error('Origem inválida');
const report = {};
for (const table of ['contacts','crm_conversations','crm_messages','crm_tasks','crm_notes','deals','pipelines','pipeline_stages','appointments','crm_files','workspace_members']) {
  const counts = {};
  for (const field of ['created_at','updated_at']) {
    const params = new URLSearchParams({ select: 'id', workspace_id: `eq.${SOURCE_WORKSPACE}`, [field]: `gt.${cutoff}`, limit: '1' });
    const response = await fetch(`${url}/rest/v1/${table}?${params}`, { method: 'GET', redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }, signal: AbortSignal.timeout(60000) });
    if (response.status === 400 && field === 'updated_at') { counts[field] = 'unavailable'; await response.body?.cancel(); continue; }
    if (!response.ok) throw new Error(`Consulta ${table}: HTTP ${response.status}`);
    const count = response.headers.get('content-range')?.split('/')[1];
    if (!/^\d+$/.test(count ?? '')) throw new Error('Contagem ausente');
    counts[field] = Number(count); await response.body?.cancel();
  }
  report[table] = counts;
}
process.stdout.write(JSON.stringify({ cutoff, measured_at: new Date().toISOString(), tables: report }) + '\n');
