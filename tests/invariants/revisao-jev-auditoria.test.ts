import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { revisarRespostaComJev } from "@/lib/ai/decisao/revisao-resposta";
import { MODELO_DO_JEV } from "@/lib/ai/decisao/cliente";

if (!process.env.TEST_DB_CONTAINER || !process.env.TEST_DB_PORT) {
  throw new Error("Rode via pnpm test:db; este teste não acessa banco de produção.");
}
const pool = new pg.Pool({host:"127.0.0.1",port:Number(process.env.TEST_DB_PORT),user:"postgres",password:"postgres",database:"postgres",max:2});
const A="09100910-0000-4000-8000-00000000000a", B="09100910-0000-4000-8000-00000000000b";
const UA="09100910-1111-4000-8000-00000000000a", UB="09100910-1111-4000-8000-00000000000b";
const log={info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}} as Logger;
const reserve={isPromise:false,suspectPhrase:null,prometeuRetornoHumano:true,retornoSoDoAssistente:false};
const receipt={em:"2026-10-09T12:00:00.000Z",por:UA};

beforeAll(async()=>{
  await pool.query("insert into auth.users(id,email) values($1,'review-a@invariant.test'),($2,'review-b@invariant.test')",[UA,UB]);
  await pool.query("insert into organizations(id,slug,legal_name,display_name,settings) values($1,'review-a','Review A','Review A',$3::jsonb),($2,'review-b','Review B','Review B','{}')",[A,B,JSON.stringify({jev:{ligado:true,aceite:receipt,contexto_revisao:{...receipt,versao:1},tarefas:{revisao_resposta:{estado:"decidindo"}}}})]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now()),($3,$4,'agent',now())",[UA,A,UB,B]);
});
afterAll(async()=>{await pool.end();});

describe("auditoria da revisão nativa com Postgres real",()=>{
  it("três probabilidades custam uma chamada; a reserva não duplica a conta JEV",async()=>{
    let covered=0;
    for(const commercial of [0.01,0.4]){
      await revisarRespostaComJev(pool,{}, {tenantId:A}, {candidate:"Mensagem de avaliação sintética."},async()=>{covered++;return reserve;},{
        log,conferirOrcamento:async()=>{},perguntar:async()=>({ok:true,modelo:MODELO_DO_JEV,latenciaMs:3,uso:{tokensDeEntrada:100,tokensDeSaida:0},respostas:{
          comercial:{tipo:"noul",noul:commercial},retorno:{tipo:"noul",noul:0.01},so_assistente:{tipo:"noul",noul:0.01},
        }}),
      });
    }
    expect(covered).toBe(1);
    const {rows}=await pool.query("select tarefa,estado,rotulo_jev,rotulo_atual,probabilidade_jev from jev_observacoes where organization_id=$1",[A]);
    expect(rows).toHaveLength(6);
    expect(rows.every(r=>r.tarefa==="revisao_resposta"&&r.estado==="decidindo")).toBe(true);
    expect(rows.filter(r=>r.rotulo_atual!==null)).toHaveLength(3);
    expect(rows.map(r=>r.rotulo_jev)).toContain("comercial:nao");
    const calls=await pool.query("select provider,purpose,status,origem_da_escolha from llm_calls where organization_id=$1",[A]);
    expect(calls.rows).toHaveLength(2);
    expect(calls.rows).toEqual(expect.arrayContaining([
      {provider:"typesafe",purpose:"promise_semantic",status:"ok",origem_da_escolha:"jev"},
      {provider:"typesafe",purpose:"promise_semantic",status:"ok",origem_da_escolha:"reserva_do_jev"},
    ]));
  });
  it("a organização vizinha não lê probabilidades nem custos pelo JWT",async()=>{
    const client=await pool.connect();
    try{
      await client.query("begin");
      await client.query("set local role authenticated");
      for(const [user,expected] of [[UA,6],[UB,0]] as const){
        await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user})]);
        expect(Number((await client.query("select count(*) as n from jev_observacoes where organization_id=$1",[A])).rows[0].n)).toBe(expected);
        expect(Number((await client.query("select count(*) as n from llm_calls where organization_id=$1",[A])).rows[0].n)).toBe(expected===6?2:0);
      }
    }finally{await client.query("rollback");client.release();}
  });
});
