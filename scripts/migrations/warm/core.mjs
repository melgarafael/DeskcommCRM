import { createHash } from 'node:crypto';
export const SOURCE_WORKSPACE = '68e16519-dac1-4e28-8762-615528a71180';
export const SOURCE_HOST = 'vfmkwbrwnubbuffqlhal.supabase.co';
export const TARGET_ORGANIZATION = '4939e89d-2f77-465e-97c5-5236cf07b57b';
export function migrationId(targetOrganization, table, sourceId) {
  if (![targetOrganization, sourceId].every(x => /^[a-f0-9-]{36}$/i.test(x)) || !/^[a-z_]+$/.test(table)) throw new Error('Identidade inválida');
  const hash = createHash('sha256').update(`warm:v1:${SOURCE_WORKSPACE}:${targetOrganization}:${table}:${sourceId}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
/** Exige decisão explícita de moeda; nunca usa ponto flutuante para converter. */
export function moneyToCents(value, currency) {
  if (!['USD','BRL','MXN'].includes(currency)) throw new Error('Moeda precisa ser confirmada');
  if (value === null) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('Valor não representável em centavos; revisão necessária');
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2,'0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Valor fora do limite seguro');
  return Number(cents);
}
export function assertScope(rows) {
  if (rows.some(row => row.workspace_id !== SOURCE_WORKSPACE)) throw new Error('Registro fora do workspace autorizado');
}
/** Download de preparação, apenas GET; relatório marca que não é snapshot transacional. */
export async function readScopedPages({url,key,table,fields,consume,fetcher=fetch}) {
  if (new URL(url).origin !== `https://${SOURCE_HOST}`) throw new Error('Projeto de origem divergente');
  if (!key || !/^[a-z_]+$/.test(table) || !fields.includes('id') || !fields.includes('workspace_id') || fields.some(f=>!/^[a-z_]+$/.test(f))) throw new Error('Contrato de extração inválido');
  let offset=0,total=null;
  const seen=new Set();
  while(total===null || offset<total) {
    const query=new URLSearchParams({select:fields.join(','),workspace_id:`eq.${SOURCE_WORKSPACE}`,order:'id.asc',limit:'500',offset:String(offset)});
    const response=await fetcher(`${url.replace(/\/$/,'')}/rest/v1/${table}?${query}`,{method:'GET',headers:{apikey:key,Authorization:`Bearer ${key}`,Prefer:'count=exact'},signal:AbortSignal.timeout(60000)});
    if(!response.ok) throw new Error(`Extração ${table}: HTTP ${response.status}`);
    const rawCount=response.headers.get('content-range')?.split('/')[1];
    if (!/^\d+$/.test(rawCount ?? '')) throw new Error('Contagem ausente');
    const count=Number(rawCount);
    if(total===null) total=count;
    if(count!==total) throw new Error('Origem mudou durante a extração');
    const rows=await response.json();
    assertScope(rows);
    if(!rows.length && offset<total) throw new Error('Página incompleta');
    for(const row of rows) { if(!row.id || seen.has(row.id)) throw new Error('ID ausente ou duplicado'); seen.add(row.id); }
    await consume(rows); offset+=rows.length;
    if(offset>total) throw new Error('Contagem excedida');
  }
  return {count:offset,consistent_snapshot:false};
}
