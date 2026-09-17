import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sourceReader, redactCredentials, digestRows } from './archive.mjs';
import { SOURCE_WORKSPACE, SOURCE_HOST } from './core.mjs';
const options = {url:`https://${SOURCE_HOST}`,key:'synthetic-secret'};
const a='11111111-1111-4111-a111-111111111111', b='22222222-2222-4222-a222-222222222222';
const response = (rows,count)=>new Response(JSON.stringify(rows),{headers:{'content-range':`0-1/${count}`}});
test('credenciais estruturadas e assinaturas não são preservadas; conteúdo e IDs permanecem',()=>{
 const omitted={};
 const clean=redactCredentials({id:a,config:{api_key:'secret',secret_ciphertext:'cipher',external_id:b},body:'Mensagem',url:'https://example.com/a?token=secret&name=file'},omitted);
 assert.deepEqual(clean,{id:a,config:{external_id:b},body:'Mensagem',url:'https://example.com/a?name=file'});
 assert.equal(Object.keys(omitted).length,3);
});
test('digest independe de ordem de linhas/chaves mas detecta alteração de conteúdo',()=>{
 assert.equal(digestRows([{a:1,b:2},{id:2}]),digestRows([{id:2},{b:2,a:1}]));
 assert.notEqual(digestRows([{a:1}]),digestRows([{a:2}]));
});
test('paginação usa GET autenticado sem redirecionar, cutoff e cursor dentro do tenant',async()=>{
 let calls=0;
 const reader=sourceReader({...options,fetcher:async(url,init)=>{
  const params=new URL(url).searchParams;calls++;
  assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  assert.equal(params.get('workspace_id'),`in.(${SOURCE_WORKSPACE})`);
  assert.equal(params.get('created_at'),'lte.2026-09-13T00:00:00.000Z');
  assert.equal(params.get('id'),calls===1?null:`gt.${a}`);
  return calls===1?response([{id:a,workspace_id:SOURCE_WORKSPACE}],2):response([{id:b,workspace_id:SOURCE_WORKSPACE}],1);
 }});
 assert.equal((await reader.rows({table:'contacts',columns:['id','workspace_id','created_at'],filter:'workspace_id',allowed:[SOURCE_WORKSPACE],cutoff:'2026-09-13T00:00:00.000Z'})).length,2);
});
test('descendente de outro pai ou tenant é recusado',async()=>{
 for(const row of [{id:a,conversation_id:b},{id:a,conversation_id:a,workspace_id:b}]){
  const reader=sourceReader({...options,fetcher:async()=>response([row],1)});
  await assert.rejects(()=>reader.rows({table:'crm_conversation_tags',columns:['id','conversation_id'],filter:'conversation_id',allowed:[a]}),/escopo/);
 }
});
test('ID duplicado e contagem desconhecida não concluem extração',async()=>{
 const reader=sourceReader({...options,fetcher:async()=>response([{id:a,workspace_id:SOURCE_WORKSPACE}],2)});
 await assert.rejects(()=>reader.rows({table:'contacts',columns:['id','workspace_id'],filter:'workspace_id',allowed:[SOURCE_WORKSPACE]}),/duplicada/);
 const unknown=sourceReader({...options,fetcher:async()=>response([], '*')});
 await assert.rejects(()=>unknown.rows({table:'contacts',columns:['id','workspace_id'],filter:'workspace_id',allowed:[SOURCE_WORKSPACE]}),/Contagem/);
});
test('escopo vazio não consulta e projeto inesperado é recusado',async()=>{
 assert.throws(()=>sourceReader({...options,url:'https://example.com'}),/Origem/);
 const reader=sourceReader({...options,fetcher:()=>assert.fail('Não consultar')});
 assert.deepEqual(await reader.rows({table:'profiles',columns:['id'],filter:'id',allowed:[]}),[]);
});
