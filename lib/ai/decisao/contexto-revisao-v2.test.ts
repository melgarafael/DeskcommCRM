import { describe,it,expect,vi } from 'vitest';
import { decidirNoPonto } from './ponto';
import { lerConfigDoJev } from './config';
const aceite={em:'2026-10-10T10:00:00Z',por:'11111111-1111-4111-8111-111111111111'};
describe('T04 v2 na última fronteira de rede',()=>{
  it('configuração conserva v1 e só registra v2 explicitamente',()=>{
    for(const versao of [1,2] as const) expect(lerConfigDoJev({jev:{contexto_revisao:{...aceite,versao}}}).contexto_revisao?.versao).toBe(versao);
    expect(lerConfigDoJev({jev:{contexto_revisao:{...aceite,versao:3}}}).contexto_revisao).toBeNull();
  });
  it('revogação após buscar a chave impede o fetch',async()=>{
    const fetchImpl=vi.fn();const check=vi.fn(async()=>false);
    const r=await decidirNoPonto({organizationId:'org',ponto:'promise_semantic',versaoContextoRevisao:2,
      estado:{contexto_decisoes:{nota:'Nota privada'}},perguntas:{retorno:{tipo:'noul',instrucao:'Tem retorno?'}}},
      {buscarChave:vi.fn(async()=> 'chave-de-fixture'),conferirContextoRevisao:check,fetchImpl});
    expect(r.ok).toBe(false);expect(check).toHaveBeenCalledWith('org');expect(fetchImpl).not.toHaveBeenCalled();
  });
});


describe('o aceite de contexto nomeia o destino que vai recebê-lo',()=>{
 it('preserva o legado TypeSafe e não transfere aceite antigo à OpenRouter',()=>{
  for(const campo of ['contexto_revisao'] as const){
   const legado={...aceite,versao:2};
   expect(lerConfigDoJev({jev:{[campo]:legado}})[campo]).toEqual(legado);
   expect(lerConfigDoJev({jev:{origem:'openrouter',[campo]:legado}})[campo]).toBeNull();
   expect(lerConfigDoJev({jev:{origem:'openrouter',[campo]:{...legado,origem:'openrouter'}}})[campo]).toMatchObject({versao:2,origem:'openrouter'});
  }
 });
 it('destino trocado entre montagem e chamada não recebe o contexto anterior',async()=>{
  const fetchImpl=vi.fn();
  const r=await decidirNoPonto({organizationId:'org',ponto:'promise_semantic',origemDoContexto:'typesafe',versaoContextoRevisao:2,
   estado:{mensagem:'Resposta fictícia'},perguntas:{retorno:{tipo:'noul',instrucao:'Tem retorno?'}}},
   {buscarDestino:async()=>({chave:'fixture',origem:'openrouter'}),conferirContextoRevisao:async()=>true,fetchImpl});
  expect(r.ok).toBe(false);expect(fetchImpl).not.toHaveBeenCalled();
 });
 it('novo aceite no mesmo destino deixa a chamada passar pelo controle de rede',async()=>{
  const fetchImpl=vi.fn(async()=>new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));
  await decidirNoPonto({organizationId:'org',ponto:'promise_semantic',origemDoContexto:'openrouter',versaoContextoRevisao:2,
   estado:{mensagem:'Resposta fictícia'},perguntas:{retorno:{tipo:'noul',instrucao:'Tem retorno?'}}},
   {buscarDestino:async()=>({chave:'fixture',origem:'openrouter'}),conferirContextoRevisao:async()=>true,fetchImpl});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
});
