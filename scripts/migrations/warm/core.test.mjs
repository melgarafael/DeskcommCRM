import { test } from 'vitest';
import assert from 'node:assert/strict';
import { migrationId,moneyToCents,readScopedPages,SOURCE_HOST,SOURCE_WORKSPACE } from './core.mjs';
const target='4939e89d-2f77-465e-97c5-5236cf07b57b';
const source='11111111-1111-4111-a111-111111111111';
test('IDs estáveis, separados por tabela e organização',()=>{
 const id=migrationId(target,'contacts',source);
 assert.equal(id,migrationId(target,'contacts',source));
 assert.notEqual(id,migrationId(target,'messages',source));
 assert.notEqual(id,migrationId(source,'contacts',source));
});
test('centavos exatos sem confundir moeda ou perder decimais',()=>{
 assert.equal(moneyToCents('640.19','USD'),64019);
 assert.equal(moneyToCents('0.29','USD'),29);
 assert.equal(moneyToCents(null,'USD'),null);
 for(const value of ['1.001','-1','1e3','9007199254740992'])assert.throws(()=>moneyToCents(value,'USD'));
 assert.throws(()=>moneyToCents('180',undefined));
});
const row=(id)=>({id,workspace_id:SOURCE_WORKSPACE});
const response=(rows,total)=>new Response(JSON.stringify(rows),{headers:{'content-range':`0-0/${total}`}});
const options=(fetcher,consume=async()=>{})=>({url:`https://${SOURCE_HOST}`,key:'fixture-not-a-secret',table:'contacts',fields:['id','workspace_id'],fetcher,consume});
test('sempre GET e workspace explícito; percorre todas as páginas mesmo se o servidor reduzir a página',async()=>{
 let call=0;const consumed=[];
 const result=await readScopedPages(options(async(url,init)=>{
  assert.equal(init.method,'GET');
  const q=new URL(url).searchParams;
  assert.equal(q.get('workspace_id'),`eq.${SOURCE_WORKSPACE}`);
  assert.equal(q.get('order'),'id.asc');
  assert.equal(q.get('offset'),String(call));
  return response([row(String(++call))],2);
 },async rows=>consumed.push(...rows)));
 assert.equal(result.count,2);assert.equal(result.consistent_snapshot,false);assert.equal(consumed.length,2);
});
test('outro tenant é recusado antes de persistir a página',async()=>{
 let wrote=false;
 await assert.rejects(readScopedPages(options(async()=>response([{id:'1',workspace_id:target}],1),async()=>{wrote=true;})),/fora do workspace/);
 assert.equal(wrote,false);
});
test('projeto errado nunca recebe a credencial',async()=>{
 let called=false;
 await assert.rejects(readScopedPages({...options(async()=>{called=true;}),url:'https://other.supabase.co'}),/divergente/);
 assert.equal(called,false);
});
test('origem mudando interrompe a extração',async()=>{
 let call=0;
 await assert.rejects(readScopedPages(options(async()=>response([row(String(call++))],call===1?2:3))),/Origem mudou/);
});
test('IDs duplicados e página vazia prematura não viram exportação válida',async()=>{
 await assert.rejects(readScopedPages(options(async()=>response([row('1'),row('1')],2))),/duplicado/);
 await assert.rejects(readScopedPages(options(async()=>response([],1))),/incompleta/);
});
test('falha HTTP não imprime corpo remoto potencialmente sensível',async()=>{
 await assert.rejects(readScopedPages(options(async()=>new Response('sensitive remote body',{status:403}))),e=>e.message==='Extração contacts: HTTP 403');
});
test('contagem desconhecida não é tratada como exportação completa',async()=>{
 await assert.rejects(readScopedPages(options(async()=>response([], '*'))),/Contagem ausente/);
});
