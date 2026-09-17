/** Analisa somente o lote privado; saída agregada/IDs técnicos, sem conteúdo pessoal. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SOURCE_WORKSPACE, moneyToCents } from './core.mjs';
const dir=process.argv[2];
if (!dir?.startsWith('/')) throw new Error('Diretório absoluto obrigatório');
const manifest=JSON.parse(await readFile(resolve(dir,'manifest.json'),'utf8'));
if(manifest.workspace_id!==SOURCE_WORKSPACE) throw new Error('Workspace divergente');
async function load(table) { return (await readFile(resolve(dir,table+'.ndjson'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)); }
const [contacts,conversations,messages,files,tasks,notes,appointments,deals,identities]=await Promise.all(['contacts','crm_conversations','crm_messages','crm_files','crm_tasks','crm_notes','appointments','deals','contact_identities'].map(load));
const groups=(rows,key)=>{
 const map=new Map();for(const row of rows){const k=key(row);if(k!==null)map.set(k,[...(map.get(k)??[]),row.id]);}return [...map.values()].filter(ids=>ids.length>1);
};
const distribution=(rows,key)=>{const result={};for(const row of rows){const k=String(row[key]);result[k]=(result[k]??0)+1;}return result;};
const shapes={},hosts={},mime={},urlFields={};let attachments=0;
function inspectUrl(value,key){if(typeof value!=='string'||!/^https?:\/\//.test(value))return;try{const host=new URL(value).hostname;hosts[host]=(hosts[host]??0)+1;urlFields[key]=(urlFields[key]??0)+1;}catch{hosts.invalid=(hosts.invalid??0)+1;}}
for(const message of messages)for(const item of message.attachments??[]){attachments++;const shape=Object.keys(item).sort().join(',');shapes[shape]=(shapes[shape]??0)+1;for(const [key,value]of Object.entries(item))inspectUrl(value,key);const type=item.mime_type??item.mimetype??item.mimeType??item.type??'unknown';mime[type]=(mime[type]??0)+1;}
for(const file of files)inspectUrl(file.file_url,'crm_files.file_url');
const report={measured_at:new Date().toISOString(),cutoff:manifest.cutoff,
 counts:Object.fromEntries(Object.entries(manifest.tables).map(([table,value])=>[table,value.count])),
 contacts:{invalid_phone:contacts.filter(c=>(c.phone_e164??c.phone)&&!/^\+\d{8,15}$/.test(c.phone_e164??c.phone)).length,
  invalid_email:contacts.filter(c=>c.email&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)).length,
  active_phone_duplicates:groups(contacts.filter(c=>!c.deleted_at&&!c.merged_into_id),c=>c.phone_e164??null),
  deleted:contacts.filter(c=>c.deleted_at).length,merged:contacts.filter(c=>c.merged_into_id).length},
 conversations:{statuses:distribution(conversations,'status'),duplicate_contact_channel_groups:groups(conversations,c=>`${c.contact_id}:${c.channel_id}`),
  without_channel:conversations.filter(c=>!c.channel_id).map(c=>({id:c.id,channel:c.channel,message_count:messages.filter(m=>m.conversation_id===c.id).length,message_channel_ids:[...new Set(messages.filter(m=>m.conversation_id===c.id).map(m=>m.channel_id))]}))},
 messages:{statuses:distribution(messages,'delivery_status'),duplicate_external_ids:groups(messages,m=>m.external_message_id??null),
  outbound_unknown:messages.filter(m=>m.direction==='outbound'&&!m.delivery_status).length,
  inbound_unknown:messages.filter(m=>m.direction==='inbound'&&!m.delivery_status).length},
 media:{attachment_records:attachments,attachment_shapes:shapes,url_hosts:hosts,url_fields:urlFields,mime_types:mime,file_records:files.length},
 tasks:{without_contact_or_deal:tasks.filter(t=>!t.contact_id&&!t.deal_id).length,with_conversation:tasks.filter(t=>t.conversation_id).length},
 notes:{visibility:distribution(notes,'visibility_scope'),without_conversation:notes.filter(n=>!n.conversation_id).length,without_contact:notes.filter(n=>!n.contact_id).length},
 appointments:{statuses:distribution(appointments,'status'),location_types:distribution(appointments,'location_type'),invalid_period:appointments.filter(a=>!a.scheduled_start||!a.scheduled_end||new Date(a.scheduled_end)<=new Date(a.scheduled_start)).length},
 deals:{count:deals.length,currency:'USD',total_value_cents:deals.reduce((n,d)=>n+(moneyToCents(d.value,'USD')??0),0)},
 identities:{types:distribution(identities,'type'),providers:distribution(identities,'provider')},
};
process.stdout.write(JSON.stringify(report,null,2)+'\n');
