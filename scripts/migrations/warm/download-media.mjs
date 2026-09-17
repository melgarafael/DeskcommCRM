/** Preserva binários em diretório privado; nunca imprime URLs assinadas ou conteúdos. */
import { mkdir, open, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceReader } from './archive.mjs';
import { SOURCE_HOST, SOURCE_WORKSPACE } from './core.mjs';
const dir=process.argv[2], archiveDir=process.argv[3];
if(!dir?.startsWith('/')||!archiveDir?.startsWith('/'))throw new Error('Diretórios absolutos obrigatórios');
process.umask(0o077);await mkdir(dir,{mode:0o700});
const archive=JSON.parse(await readFile(resolve(archiveDir,'manifest.json'),'utf8'));
if(archive.workspace_id!==SOURCE_WORKSPACE)throw new Error('Workspace divergente');
const reader=sourceReader({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY});
const messages=await reader.rows({table:'crm_messages',columns:['id','workspace_id','attachments','created_at'],filter:'workspace_id',allowed:[SOURCE_WORKSPACE],cutoff:archive.cutoff});
const files=await reader.rows({table:'crm_files',columns:['id','workspace_id','file_url','file_type','file_size','created_at'],filter:'workspace_id',allowed:[SOURCE_WORKSPACE],cutoff:archive.cutoff});
const expectedIds=async table=>new Set((await readFile(resolve(archiveDir,table+'.ndjson'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line).id));
const messageIds=await expectedIds('crm_messages'),fileIds=await expectedIds('crm_files');
if(messages.some(row=>!messageIds.has(row.id))||messages.length!==messageIds.size||files.some(row=>!fileIds.has(row.id))||files.length!==fileIds.size)throw new Error('Escopo de mídia divergiu do lote');
const queue=[];
for(const row of messages)for(const [index,item] of (row.attachments??[]).entries())queue.push({table:'crm_messages',source_id:row.id,index,url:item.url,mime:item.type});
for(const row of files)queue.push({table:'crm_files',source_id:row.id,index:0,url:row.file_url,mime:row.file_type,declared_bytes:row.file_size});
const allowedHosts=new Set([SOURCE_HOST,'lookaside.fbsbx.com','vidafit-capa.vercel.app','waha.metamorph-ai.com']);
const cache=new Map(),results=[];let current=0,finished=0;
async function download(rawUrl){
 let url;try{url=new URL(rawUrl);}catch{return {status:'invalid_url'};}
 if(url.protocol!=='https:'||!allowedHosts.has(url.hostname)||url.username||url.password||url.port) return {status:'unapproved_origin'};
 const headers={};
 if(url.hostname===SOURCE_HOST){
  if(!url.pathname.startsWith('/storage/v1/object/'))return {status:'unsupported_storage_path'};
  headers.apikey=process.env.SUPABASE_SERVICE_ROLE_KEY;headers.Authorization=`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  url.pathname=url.pathname.replace('/object/public/','/object/authenticated/').replace('/object/sign/','/object/authenticated/');
  url.search='';
 }
 const id=createHash('sha256').update(rawUrl).digest('hex');
 const temporary=resolve(dir,id+'.partial');let file;
 try{
  const response=await fetch(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok){await response.body?.cancel();return {status:'http_error',http_status:response.status,host:url.hostname};}
  const mime=response.headers.get('content-type')?.split(';')[0]??null;
  if(mime==='text/html'||mime==='application/json'){await response.body?.cancel();return {status:'unexpected_content_type',mime,host:url.hostname};}
  const declared=Number(response.headers.get('content-length')??0);
  if(declared>512*1024*1024){await response.body?.cancel();return {status:'over_size_limit',declared_bytes:declared};}
  file=await open(temporary,'wx',0o600);const hash=createHash('sha256');let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512*1024*1024)throw new Error('size_limit');hash.update(chunk);await file.write(chunk);}
  await file.close();file=null;
  if(bytes===0)throw new Error('empty_body');
  if(declared&&!response.headers.get('content-encoding')&&declared!==bytes)throw new Error('length_mismatch');
  const sha256=hash.digest('hex');await rename(temporary,resolve(dir,sha256+'.bin'));
  return {status:'downloaded',sha256,bytes,mime,host:url.hostname};
 }catch(error){if(file)await file.close();await unlink(temporary).catch(()=>{});return {status:'download_error',reason:['size_limit','empty_body','length_mismatch'].includes(error.message)?error.message:'network_or_io_failure',host:url.hostname};}
}
async function worker(){while(current<queue.length){const item=queue[current++];const key=String(item.url);if(!cache.has(key))cache.set(key,download(item.url));const result=await cache.get(key);results.push({table:item.table,source_id:item.source_id,index:item.index,declared_bytes:item.declared_bytes??null,...result});finished++;if(finished%100===0)process.stdout.write(JSON.stringify({processed:finished,total:queue.length})+'\n');}}
await Promise.all(Array.from({length:4},()=>worker()));
results.sort((a,b)=>`${a.table}:${a.source_id}:${a.index}`.localeCompare(`${b.table}:${b.source_id}:${b.index}`));
await writeFile(resolve(dir,'media-manifest.json'),JSON.stringify({workspace_id:SOURCE_WORKSPACE,cutoff:archive.cutoff,completed_at:new Date().toISOString(),references:results},null,2),{mode:0o600,flag:'wx'});
const statuses={};for(const item of results)statuses[item.status]=(statuses[item.status]??0)+1;
process.stdout.write(JSON.stringify({completed:true,references:results.length,statuses,unique_urls:cache.size})+'\n');
