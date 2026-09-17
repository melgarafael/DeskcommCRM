/** Exportação PARCIAL de preparação; não importa nem publica registros.
 * Executar no servidor: node --env-file=<env-do-Warm> export-core.mjs /diretorio-protegido-novo
 * Conteúdos JSON livres/configurações/credenciais ficam fora até revisão específica.
 */
import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readScopedPages, SOURCE_WORKSPACE } from './core.mjs';
const contracts={
 contacts:'id,workspace_id,name,email,phone,phone_e164,email_norm,source,preferred_language,merged_into_id,deleted_at,created_at,updated_at',
 pipelines:'id,workspace_id,name,description,pipeline_type,is_active,created_at,updated_at',
 pipeline_stages:'id,workspace_id,pipeline_id,name,position,stage_semantic_type,is_closed_stage,stage_color,probability,is_default_start_stage,created_at,updated_at',
 deals:'id,workspace_id,title,value,stage_id,contact_id,company_id,owner_id,conversation_id,parent_deal_id,origin_deal_id,origin_type,linked_process_type,cancelled_at,cancel_reason,created_at,updated_at',
 crm_conversations:'id,workspace_id,contact_id,channel,channel_id,status,assigned_agent_id,assigned_team_id,subject,last_customer_message_at,last_agent_message_at,external_thread_id,ai_enabled,created_at,updated_at',
 crm_messages:'id,workspace_id,conversation_id,direction,content,channel,channel_id,external_message_id,delivery_status,sender_id,sender_external_id,transcription,created_at,updated_at',
 crm_tasks:'id,workspace_id,title,description,status,due_at,assignee_id,contact_id,deal_id,conversation_id,created_at,updated_at',
 crm_notes:'id,workspace_id,content,contact_id,deal_id,conversation_id,author_id,note_type,visibility_scope,created_at,updated_at',
 crm_tags:'id,workspace_id,name,color,created_at',
 crm_contact_consents:'id,workspace_id,contact_id,basis,captured_at,source,revoked_at,expires_at,created_by',
 crm_channels:'id,workspace_id,name,channel_type,provider,status,external_identifier,phone_number,created_at,updated_at',
};
const destination=process.argv[2];
if(!destination || !destination.startsWith('/')) throw new Error('Informe um diretório absoluto novo e protegido');
process.umask(0o077);
const dir=resolve(destination);
await mkdir(dir,{recursive:false,mode:0o700});
const manifest={workspace_id:SOURCE_WORKSPACE,started_at:new Date().toISOString(),purpose:'partial-preparation-only',consistent_snapshot:false,production_import_allowed:false,tables:{},excluded:'Anexos, JSON livre, demais tabelas, usuários, canais ativos e segredos exigem etapas próprias descritas no plano.'};
try {
 for(const [table,projection] of Object.entries(contracts)) {
  const file=await open(`${dir}/${table}.ndjson.partial`,'wx',0o600);
  const hash=createHash('sha256');
  let result;
  try { result=await readScopedPages({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY,table,fields:projection.split(','),consume:async rows=>{for(const row of rows){const text=JSON.stringify(row)+'\n';hash.update(text);await file.write(text);}}}); }
  finally { await file.close(); }
  await rename(`${dir}/${table}.ndjson.partial`,`${dir}/${table}.ndjson`);
  manifest.tables[table]={...result,sha256:hash.digest('hex'),fields:projection.split(',')};
 }
 manifest.completed_at=new Date().toISOString();
 await writeFile(`${dir}/manifest.json`,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
 process.stdout.write('Exportação parcial de preparação concluída; não autorizada para importação em produção.\n');
} catch(error) {
 await writeFile(`${dir}/FAILED`,`${new Date().toISOString()}\n`,{mode:0o600});
 process.stderr.write(error.message+'\n');process.exitCode=1;
}
