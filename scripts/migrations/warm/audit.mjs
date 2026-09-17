/** Somente leitura. Executar na VPS de origem com o env do serviço Warm.
 * node --env-file=/etc/warm-connect/api.env audit.mjs > audit.json
 * Nunca exporta nomes de pessoas, mensagens, telefones, e-mails ou credenciais.
 */
const workspace = '68e16519-dac1-4e28-8762-615528a71180';
const expectedHost = 'vfmkwbrwnubbuffqlhal.supabase.co';
export async function audit({ url, key, fetcher = fetch }) {
  if (new URL(url).origin !== `https://${expectedHost}`) throw new Error('Projeto de origem divergente');
  if (!key) throw new Error('Credencial de origem ausente');
  const base = url.replace(/\/$/, '') + '/rest/v1/';
  async function get(table, params = {}, count = false) {
    const response = await fetcher(base + table + '?' + new URLSearchParams(params), {
      method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}`,
        ...(count ? { Prefer: 'count=exact' } : {}) }, signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Consulta ${table || 'schema'} recusada: HTTP ${response.status}`);
    return response;
  }
  async function rows(table, select) {
    const output = [];
    let offset = 0, total = null;
    do {
      const response = await get(table, { select, workspace_id: `eq.${workspace}`, order: 'id.asc', limit: '500', offset: String(offset) }, true);
      const n = Number(response.headers.get('content-range')?.split('/')[1]);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Contagem ausente: ${table}`);
      if (total === null) total = n;
      if (total !== n) throw new Error(`Origem mudou durante leitura: ${table}; repetir levantamento`);
      const page = await response.json();
      if (!page.length && offset < total) throw new Error(`Paginação incompleta: ${table}`);
      output.push(...page); offset += page.length;
    } while (offset < total);
    if (new Set(output.map(r => r.id)).size !== output.length) throw new Error(`IDs repetidos: ${table}`);
    return output;
  }
  const schema = await (await get('', {}, false)).json();
  const definitions = schema.definitions ?? {};
  const tables = Object.entries(definitions).filter(([, d]) => d.properties?.workspace_id);
  const inventory = {};
  for (let i = 0; i < tables.length; i += 4) {
    await Promise.all(tables.slice(i, i + 4).map(async ([name, d]) => {
      const r = await get(name, { select: 'workspace_id', workspace_id: `eq.${workspace}`, limit: '1' }, true);
      const count = Number(r.headers.get('content-range')?.split('/')[1]);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Contagem inválida: ${name}`);
      inventory[name] = { count, columns: Object.keys(d.properties) };
    }));
  }
  const projections = {
    contacts: 'id,merged_into_id,deleted_at,phone_e164,email_norm',
    crm_conversations: 'id,contact_id,channel_id,channel,status,assigned_agent_id,assigned_team_id',
    crm_messages: 'id,conversation_id,channel_id,channel,direction,delivery_status,sender_id,attachments',
    deals: 'id,stage_id,contact_id,owner_id,conversation_id,value,cancelled_at',
    pipeline_stages: 'id,pipeline_id,stage_semantic_type,is_closed_stage',
    pipelines: 'id,is_active',
    crm_channels: 'id,channel_type,provider,status',
    crm_tasks: 'id,status,assignee_id,contact_id,deal_id,conversation_id',
    crm_notes: 'id,note_type,visibility_scope,contact_id,deal_id,conversation_id,author_id',
    crm_contact_consents: 'id,contact_id,basis,revoked_at,expires_at',
    crm_files: 'id,file_type,file_size,contact_id,conversation_id,deal_id',
    appointments: 'id,status,confirmation_status,contact_id,conversation_id,deal_id,owner_id,assigned_user_id',
    workspace_members: 'id,user_id,status,role_id',
    contact_identities: 'id,contact_id,type,provider',
  };
  const data = {};
  for (const [table, fields] of Object.entries(projections)) data[table] = await rows(table, fields);
  const ids = Object.fromEntries(Object.entries(data).map(([table, values]) => [table, new Set(values.map(v => v.id))]));
  ids.members = new Set(data.workspace_members.map(v => v.user_id));
  const links = {
    contacts: { merged_into_id: 'contacts' },
    crm_conversations: { contact_id: 'contacts', channel_id: 'crm_channels', assigned_agent_id: 'members' },
    crm_messages: { conversation_id: 'crm_conversations', channel_id: 'crm_channels' },
    deals: { contact_id: 'contacts', stage_id: 'pipeline_stages', conversation_id: 'crm_conversations', owner_id: 'members' },
    pipeline_stages: { pipeline_id: 'pipelines' },
    crm_tasks: { contact_id: 'contacts', deal_id: 'deals', conversation_id: 'crm_conversations', assignee_id: 'members' },
    crm_notes: { contact_id: 'contacts', deal_id: 'deals', conversation_id: 'crm_conversations', author_id: 'members' },
    crm_files: { contact_id: 'contacts', deal_id: 'deals', conversation_id: 'crm_conversations' },
    appointments: { contact_id: 'contacts', deal_id: 'deals', conversation_id: 'crm_conversations', assigned_user_id: 'members' },
    crm_contact_consents: { contact_id: 'contacts' },
    contact_identities: { contact_id: 'contacts' },
  };
  const relationships = [];
  for (const [table, fields] of Object.entries(links)) for (const [field, target] of Object.entries(fields)) {
    relationships.push({ table, field, target, missing: data[table].filter(r => r[field] && !ids[target].has(r[field])).length,
      nulls: data[table].filter(r => !r[field]).length });
  }
  const group = (table, field) => Object.fromEntries([...new Set(data[table].map(r => r[field]))].map(value => [String(value), data[table].filter(r => r[field] === value).length]));
  const duplicateGroups = field => {
    const counts = new Map();
    for (const r of data.contacts) if (r[field] && !r.deleted_at && !r.merged_into_id) counts.set(r[field], (counts.get(r[field]) ?? 0) + 1);
    return [...counts.values()].filter(n => n > 1).length;
  };
  return { measured_at: new Date().toISOString(), workspace_id: workspace, consistent_snapshot: false, inventory,
    unscoped: Object.entries(definitions).filter(([,d]) => !d.properties?.workspace_id).map(([name,d])=>({name,columns:Object.keys(d.properties??{})})),
    relationships, distributions: Object.fromEntries([
      ['crm_conversations','channel'],['crm_conversations','status'],['crm_messages','direction'],['crm_messages','delivery_status'],
      ['crm_channels','channel_type'],['crm_channels','provider'],['crm_tasks','status'],['crm_notes','visibility_scope'],
      ['crm_notes','note_type'],['pipeline_stages','stage_semantic_type'],['crm_contact_consents','basis'],['appointments','status'],
    ].map(([t,f])=>[`${t}.${f}`,group(t,f)])),
    contacts: { merged: data.contacts.filter(r=>r.merged_into_id).length, deleted:data.contacts.filter(r=>r.deleted_at).length,
      duplicate_phone_groups:duplicateGroups('phone_e164'),duplicate_email_groups:duplicateGroups('email_norm') },
    attachments: { messages_with_attachments:data.crm_messages.filter(r=>Array.isArray(r.attachments)&&r.attachments.length).length,
      unexpected_shapes:data.crm_messages.filter(r=>r.attachments!==null&&!Array.isArray(r.attachments)).length,
      file_records:data.crm_files.length,total_file_bytes:data.crm_files.reduce((n,r)=>n+Number(r.file_size??0),0) },
  };
}
if (process.argv[1]?.endsWith('/audit.mjs')) {
  audit({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY})
    .then(r=>process.stdout.write(JSON.stringify(r,null,2)+'\n'))
    .catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
}
