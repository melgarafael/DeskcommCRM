import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { casePromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { decidirRevisao } from "@/lib/agent-engine/guardrails/promise/decisao-do-jev";
import { lerConfigDoJev } from "./config";
import { estadoAoLigar, estadoEfetivoDaTarefa, TAREFA_DA_REVISAO_DE_RESPOSTA } from "./tarefas";
import { pacoteParaJev, perguntasDaRevisao, revisarRespostaComJev } from "./revisao-resposta";
import type { ResultadoDaDecisao } from "./cliente";

const ACEITE = { em: "2026-10-09T12:00:00.000Z", por: "22222222-2222-4222-8222-222222222222" };
const contexto = { ...ACEITE, versao: 1 as const };
const vReserva = { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: true, retornoSoDoAssistente: true };
const respostas = (comercial=0.01, retorno=0.02, so_assistente=0.03) => ({
  comercial: { tipo: "noul" as const, noul: comercial },
  retorno: { tipo: "noul" as const, noul: retorno },
  so_assistente: { tipo: "noul" as const, noul: so_assistente },
});
const resposta = (c=0.01, r=0.02, a=0.03): ResultadoDaDecisao => ({
  ok: true, respostas: respostas(c,r,a), modelo: "jev-1.13.0", uso: { tokensDeEntrada: 20, tokensDeSaida: 0 }, latenciaMs: 1,
});
let seq=0;
function bancada(estado="decidindo", r: ResultadoDaDecisao=resposta()) {
  const config = lerConfigDoJev({ jev: { ligado: true, aceite: ACEITE, contexto_revisao: contexto, tarefas: { revisao_resposta: { estado } } } });
  const pool = { query: vi.fn(async () => ({ rows: [{ id: "linha" }] })) } as unknown as pg.Pool;
  const reserva = vi.fn(async () => vReserva);
  const perguntar = vi.fn(async () => r);
  const conferirOrcamento = vi.fn(async () => {});
  const deps = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as Logger, lerConfig: vi.fn(async () => config), perguntar, conferirOrcamento };
  const ids = { tenantId: `teste-revisao-${++seq}`, jobId: "job-do-servidor", leadId: "contato-do-servidor" };
  return { pool, reserva, perguntar, conferirOrcamento, deps, ids,
    executar: () => revisarRespostaComJev(pool, {}, ids, { candidate: "Te retorno amanhã." }, reserva, deps) };
}

describe("probabilidades da revisão", () => {
  it("baixa probabilidade significa não, sem pagar reserva", () => {
    expect(decidirRevisao(respostas())).toMatchObject({ motivo: "decidiu", veredito: { isPromise:false, prometeuRetornoHumano:false, retornoSoDoAssistente:false } });
  });
  it("limites inclusivos; oferta e autoria independentes", () => {
    expect(decidirRevisao(respostas(0.8,0.8,0.2))).toMatchObject({ motivo:"decidiu", veredito:{isPromise:true,prometeuRetornoHumano:true,retornoSoDoAssistente:false} });
  });
  it("retorno próprio com alta probabilidade", () => {
    expect(decidirRevisao(respostas(0.2,1,0.8))).toMatchObject({ motivo:"decidiu", veredito:{isPromise:false,prometeuRetornoHumano:true,retornoSoDoAssistente:true} });
  });
  it.each([0.200001,0.29,0.37,0.5,0.799999])("autoria incerta %s chama reserva", p => {
    expect(decidirRevisao(respostas(0.01,0.92,p))).toMatchObject({motivo:"duvida",campo:"so_assistente"});
  });
  it.each(["comercial","retorno"] as const)("%s incerto chama reserva", s => {
    const r=respostas();r[s].noul=0.29;expect(decidirRevisao(r)).toMatchObject({motivo:"duvida",campo:s});
  });
  it("autoria incerta irrelevante sem retorno", () => {
    expect(decidirRevisao(respostas(0.1,0.1,0.5))).toMatchObject({motivo:"decidiu",veredito:{retornoSoDoAssistente:false}});
  });
  it.each([NaN,Infinity,-0.1,1.1])("probabilidade inválida %s nunca aprova sozinha", p => {
    expect(decidirRevisao(respostas(p))).toMatchObject({motivo:"resposta_ilegivel",campo:"comercial"});
  });
  it("campo ausente chama reserva", () => { expect(decidirRevisao({})).toMatchObject({motivo:"resposta_ilegivel"}); });
});

describe("consentimento próprio da revisão", () => {
  it.each([undefined,null,"ilegal"])("aceite de roteador não substitui revisão %s", c => {
    const config=lerConfigDoJev({jev:{ligado:true,aceite:{...ACEITE,alcance:"conversa"},contexto_roteador:contexto,contexto_revisao:c,tarefas:{revisao_resposta:{estado:"decidindo"}}}});
    expect(estadoEfetivoDaTarefa(config,TAREFA_DA_REVISAO_DE_RESPOSTA)).toBe("desligada");
    expect(estadoAoLigar(config,TAREFA_DA_REVISAO_DE_RESPOSTA)).toBe("desligada");
  });
  it("consentimento sozinho não ativa tarefa", () => {
    const c=lerConfigDoJev({jev:{ligado:true,aceite:ACEITE,contexto_revisao:contexto}});
    expect(estadoEfetivoDaTarefa(c,TAREFA_DA_REVISAO_DE_RESPOSTA)).toBe("desligada");
  });
  it("interruptor mestre prevalece sobre aceite e escolha", () => {
    const c=lerConfigDoJev({jev:{ligado:false,aceite:ACEITE,contexto_revisao:contexto,tarefas:{revisao_resposta:{estado:"decidindo"}}}});
    expect(estadoEfetivoDaTarefa(c,TAREFA_DA_REVISAO_DE_RESPOSTA)).toBe("desligada");
  });
});

describe("JEV nativo com reserva", () => {
  it("decisão clara evita chamada LLM e grava uma conta com três sinais", async () => {
    const b=bancada();expect(await b.executar()).toMatchObject({isPromise:false,prometeuRetornoHumano:false});
    expect(b.reserva).not.toHaveBeenCalled();expect(b.perguntar).toHaveBeenCalledOnce();
    const [sql,params]=vi.mocked(b.pool.query).mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain("jsonb_to_recordset");expect(JSON.parse(String(params[5]))).toHaveLength(3);
    expect(params[0]).toBe(b.ids.tenantId);expect(params[11]).toBe("jev");
  });
  it("observação conserva a reserva mesmo discordando", async () => {
    const b=bancada("observando");expect(await b.executar()).toEqual(vReserva);expect(b.reserva).toHaveBeenCalledOnce();
    expect(b.pool.query).toHaveBeenCalledWith(expect.any(String),expect.arrayContaining(["jev_observacao"]));
  });
  it("37% no terceiro sinal usa reserva e preserva seu comercial", async () => {
    const b=bancada("decidindo",resposta(0.01,0.92,0.37));expect(await b.executar()).toEqual(vReserva);
    expect(b.reserva).toHaveBeenCalledOnce();
    expect(b.pool.query).toHaveBeenCalledWith(expect.any(String),expect.arrayContaining(["reserva_do_jev"]));
  });
  it.each(["provedor_indisponivel","sem_credencial","contrato_invalido"] as const)("%s devolve reserva",async motivo=>{
    const b=bancada("decidindo",{ok:false,motivo,exigeAcao:false,defeitoNosso:false,status:null});
    expect(await b.executar()).toEqual(vReserva);expect(b.reserva).toHaveBeenCalledOnce();
  });
  it("campo inválido devolve reserva e contabiliza chamada",async()=>{
    const b=bancada("decidindo",{...resposta(),ok:true,respostas:respostas(NaN),modelo:"jev-1.13.0",uso:{tokensDeEntrada:1,tokensDeSaida:0},latenciaMs:1});
    expect(await b.executar()).toEqual(vReserva);expect(b.pool.query).toHaveBeenCalled();
  });
  it("modelo inesperado nunca decide sozinho", async()=>{
    const r=resposta();if(r.ok)r.modelo="jev-futuro";const b=bancada("decidindo",r);
    expect(await b.executar()).toEqual(vReserva);
  });
  it("reserva falha não transforma dúvida em aprovação",async()=>{
    const b=bancada("decidindo",resposta(0.4));b.reserva.mockRejectedValueOnce(new Error("sem crédito"));
    await expect(b.executar()).rejects.toThrow("sem crédito");expect(b.pool.query).toHaveBeenCalled();
  });
  it("orçamento bloqueado impede ambos os fornecedores",async()=>{
    const b=bancada();b.conferirOrcamento.mockRejectedValueOnce(new Error("orcamento_esgotado"));
    await expect(b.executar()).rejects.toThrow("orcamento_esgotado");expect(b.perguntar).not.toHaveBeenCalled();expect(b.reserva).not.toHaveBeenCalled();
  });
  it("revogação impede rede e conta JEV", async()=>{
    const b=bancada();b.deps.lerConfig.mockResolvedValueOnce(lerConfigDoJev({jev:{ligado:true,aceite:ACEITE,contexto_revisao:null,tarefas:{revisao_resposta:{estado:"decidindo"}}}}));
    expect(await b.executar()).toEqual(vReserva);expect(b.perguntar).not.toHaveBeenCalled();expect(b.pool.query).not.toHaveBeenCalled();
  });
  it("leva mesmo conteúdo aprovado, histórico completo e omite referências internas",()=>{
    const p={candidate:"Aula experimental gratuita.",commercialEvidence:[{origem:"conhecimento" as const,referencia:"id-interno",titulo:"Oferta",conteudo:"Uma aula grátis de 40 minutos."}],conversationContext:{mensagens:[{papel:"cliente" as const,texto:"Tenho receio."}],resumo:"Quer nadar",limitado:false,momento:"2026-10-09T12:00:00Z",fuso:"America/Sao_Paulo"}};
    const e=pacoteParaJev(p);expect(e).toMatchObject({mensagem:p.candidate,contexto_conversa:p.conversationContext});
    expect(JSON.stringify(e)).toContain(p.commercialEvidence[0]!.conteudo);expect(JSON.stringify(e)).not.toContain("id-interno");
  });
  it("PII reconhecida é ocultada em candidata, evidência e histórico",()=>{
    const e=pacoteParaJev({candidate:"CPF 123.456.789-00",commercialEvidence:[{origem:"conhecimento",referencia:"x",titulo:"Teste",conteudo:"a@b.com"}],conversationContext:{mensagens:[{papel:"cliente",texto:"a@b.com"}],resumo:null,limitado:false,momento:"agora",fuso:"UTC"}});
    expect(JSON.stringify(e)).not.toMatch(/123\.456\.789-00|a@b\.com/);
  });
  it("noul não recebe o contrato JSON nem as duas perguntas juntas",()=>{
    const p=perguntasDaRevisao(true);
    for(const q of Object.values(p)) {
      expect(q.instrucao).not.toContain("Responda SOMENTE JSON");
      expect(q.criterios).toMatchObject({true:expect.any(String),false:expect.any(String)});
    }
    expect(p.comercial.instrucao).not.toContain("## Pergunta 2");
    expect(p.retorno.instrucao).not.toContain("humanReturnPhrase");
    expect(p.comercial.instrucao).toContain("oferta gratuita aprovada autoriza informar essa oferta");
    expect(p.retorno.instrucao).toContain("Leia SOMENTE a candidata");
  });
  it("perguntas distintas não ativam a tarefa de pedido de humano",()=>{
    expect(Object.keys(perguntasDaRevisao(true))).toEqual(["comercial","retorno","so_assistente"]);
  });
});


describe("veredito JEV chega ao gate operacional existente",()=>{
  it.each([false,true])("retorno exclusivo da IA exige follow-up efetivo: %s",async agendado=>{
    const b=bancada("decidindo",resposta(0.01,0.98,0.99));
    const semanticPromise=await b.executar();
    const ctx={body:"Te retorno amanhã de manhã.",casesEnabled:true,hasOpenCase:false,openedCaseThisTurn:false,semanticPromise,followup:{disponivel:true,agendadoNesteTurno:agendado}} as GateContext;
    expect(casePromiseGate.evaluate(ctx).pass).toBe(agendado);
  });
  it.each([false,true])("contato da equipe exige caso efetivo: %s",async abriu=>{
    const b=bancada("decidindo",resposta(0.01,0.98,0.01));
    const semanticPromise=await b.executar();
    const ctx={body:"A equipe vai te ligar.",casesEnabled:true,hasOpenCase:false,openedCaseThisTurn:abriu,semanticPromise,followup:{disponivel:true,agendadoNesteTurno:true}} as GateContext;
    expect(casePromiseGate.evaluate(ctx).pass).toBe(abriu);
  });
  it("professor avalia durante a aula não depende de caso",async()=>{
    const b=bancada();const semanticPromise=await b.executar();
    const body="O professor avalia seu nível na aula experimental gratuita.";
    expect(detectHumanPromise(body)).toBe(false);
    expect(casePromiseGate.evaluate({body,casesEnabled:true,hasOpenCase:false,openedCaseThisTurn:false,semanticPromise} as GateContext).pass).toBe(true);
  });
  it("léxico mantém compromisso de equipe mesmo com semântica negativa",async()=>{
    const b=bancada();const semanticPromise=await b.executar();
    expect(casePromiseGate.evaluate({body:"Vou pedir para a equipe te ligar.",casesEnabled:true,hasOpenCase:false,openedCaseThisTurn:false,semanticPromise} as GateContext).pass).toBe(false);
  });
});
