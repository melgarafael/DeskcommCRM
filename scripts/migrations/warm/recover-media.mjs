/** Segunda tentativa usando apenas as credenciais atuais da própria origem. */
import { readFile, open, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceReader } from './archive.mjs';
import { SOURCE_HOST, SOURCE_WORKSPACE } from './core.mjs';
const dir=process.argv[2];if(!dir?.startsWith('/'))throw new Error('Diretório absoluto obrigatório');
process.umask(0o077);
const manifest=JSON.parse(await readFile(resolve(dir,'media-manifest.json'),'utf8'));
if(manifest.workspace_id!==SOURCE_WORKSPACE)throw new Error('Escopo divergente');
const reader=sourceReader({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY});
const failed=manifest.references.filter(r=>r.status!=='downloaded');
const ids=[...new Set(failed.filter(r=>r.table==='crm_messages').map(r=>r.source_id))];
const fileIds=[...new Set(failed.filter(r=>r.table==='crm_files').map(r=>r.source_id))];
// As PKs vêm exclusivamente de um manifesto já escopado; validação adicional de workspace no reader.
const messages=await reader.rows({table:'crm_messages',columns:['id','workspace_id','channel_id','raw_payload','attachments'],filter:'id',allowed:ids});
const files=await reader.rows({table:'crm_files',columns:['id','workspace_id','file_url'],filter:'id',allowed:fileIds});
const channels=await reader.rows({table:'crm_channels',columns:['id','workspace_id','config'],filter:'workspace_id',allowed:[SOURCE_WORKSPACE]});
const byMessage=new Map(messages.map(r=>[r.id,r])),byFile=new Map(files.map(r=>[r.id,r])),byChannel=new Map(channels.map(r=>[r.id,r]));
async function save(url,headers,reference){
 const id=createHash('sha256').update(`${reference.table}:${reference.source_id}:${reference.index}`).digest('hex');
 const temporary=resolve(dir,id+'.recovery.partial');let file;
 try{
  const u=new URL(url);
  if(u.protocol!=='https:'||u.port||u.username||u.password||![SOURCE_HOST,'lookaside.fbsbx.com','waha.metamorph-ai.com'].includes(u.hostname))return {recovery_error:'unapproved_host'};
  const res=await fetch(u,{headers,redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!res.ok){await res.body?.cancel();return {recovery_error:`http_${res.status}`};}
  const mime=res.headers.get('content-type')?.split(';')[0]??null;
  if(['text/html','application/json'].includes(mime)){await res.body?.cancel();return {recovery_error:'unexpected_content_type'};}
  file=await open(temporary,'wx',0o600);let bytes=0;const hash=createHash('sha256');
  for await(const chunk of res.body){bytes+=chunk.length;if(bytes>512*1024*1024)throw new Error('size_limit');hash.update(chunk);await file.writeFile(chunk);}
  await file.close();file=null;if(!bytes)throw new Error('empty_body');
  const sha256=hash.digest('hex');await rename(temporary,resolve(dir,sha256+'.bin'));
  return {status:'downloaded',sha256,bytes,mime,host:u.hostname,recovered:true};
 }catch{return {recovery_error:'network_io_or_empty_body'};}
 finally{if(file)await file.close();await unlink(temporary).catch(()=>{});}
}
let current=0,completed=0;
async function worker(){while(current<failed.length){const reference=failed[current++];const msg=byMessage.get(reference.source_id);
 const raw=reference.table==='crm_messages'?msg?.attachments?.[reference.index]?.url:byFile.get(reference.source_id)?.file_url;
 let result={recovery_error:'missing_url'};
 if(typeof raw==='string'&&raw.startsWith('https://')){
  const url=new URL(raw);
  if(url.hostname==='lookaside.fbsbx.com'){
   const token=byChannel.get(msg?.channel_id)?.config?.access_token;
   const m=msg?.raw_payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
   const mediaId=['image','video','audio','document','sticker'].map(k=>m?.[k]?.id).find(Boolean)??url.searchParams.get('mid');
   if(token&&mediaId&&/^\d+$/.test(String(mediaId))){
    try{
     // Mesma operação GET/versionamento já usada pelo proxy de mídia da origem.
     const r=await fetch(`https://graph.facebook.com/v21.0/${mediaId}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
     if(r.ok){const body=await r.json();result=body.url?await save(body.url,{Authorization:`Bearer ${token}`},reference):{recovery_error:'graph_missing_url'};}
     else{result={recovery_error:`graph_http_${r.status}`};await r.body?.cancel();}
    }catch{result={recovery_error:'graph_network_failure'};}
   }else result={recovery_error:'missing_media_identity_or_credential'};
  }else if(url.hostname===SOURCE_HOST){
   if(url.pathname.startsWith('/storage/v1/object/')){
    url.pathname=url.pathname.replace('/object/sign/','/object/authenticated/').replace('/object/public/','/object/authenticated/');url.search='';
    result=await save(url,{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`},reference);
   }else result={recovery_error:'unsupported_storage_path'};
  }else if(url.hostname==='waha.metamorph-ai.com'){
   result=process.env.WAHA_API_KEY?await save(url,{'X-Api-Key':process.env.WAHA_API_KEY},reference):{recovery_error:'missing_source_credential'};
  }
 }
 Object.assign(reference,result);completed++;if(completed%50===0)process.stdout.write(JSON.stringify({retried:completed,total:failed.length})+'\n');
}}
await Promise.all(Array.from({length:4},()=>worker()));
manifest.recovery_completed_at=new Date().toISOString();
await writeFile(resolve(dir,'media-manifest-v2.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
const newFiles=[...new Set(failed.filter(r=>r.recovered).map(r=>r.sha256+'.bin'))];
await writeFile(resolve(dir,'recovered-files.list'),[...newFiles,'media-manifest-v2.json'].join('\n')+'\n',{mode:0o600,flag:'wx'});
const failures={};for(const r of failed.filter(r=>r.status!=='downloaded'))failures[r.recovery_error]=(failures[r.recovery_error]??0)+1;
process.stdout.write(JSON.stringify({recovered:failed.filter(r=>r.recovered).length,remaining:failed.filter(r=>r.status!=='downloaded').length,failures})+'\n');
