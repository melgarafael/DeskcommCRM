import type pg from "pg";
import { beforeEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({ler:vi.fn(),humano:vi.fn(),classificar:vi.fn(),fronteira:vi.fn()}));
vi.mock("../../agent/contexto-do-atendimento",()=>({carregarContextoDoAtendimento:mock.ler}));
vi.mock("../../agent/contexto-de-decisao-humana",()=>({carregarContextoDeDecisaoHumana:mock.humano}));
vi.mock("./semantic",()=>({classifyPromise:mock.classificar}));
vi.mock("@/lib/atendimento/fronteira-server",()=>({guardServiceEffect:mock.fronteira}));
import { criarRevisorDePedidoDeAgenda } from "./agenda-pedido";
const pedido={estado:"present",tipoTurno:"inbound_turn",gatilhoEm:"2026-10-16T09:00Z",mensagem:{id:"mensagem-origem",text:"Pode marcar a consulta hoje às 14h40",at:"2026-10-16T09:00Z",origem:"client_message"}};
const contexto={versao:1,fingerprint:"a",pedido,perfil:[],decisoes:[],operacoes:[],continuidade:[],cobertura:[]};
const proposta={acao:"criar" as const,servico:"Consulta",inicio:"2026-10-16T17:40:00Z",fuso:"America/Sao_Paulo",dia:"2026-10-16",horario:"14:40",quando:"Sex 16/10 às 14:40",beneficiarios:["contato_atendido"]};
function bancada(requestJobId?:string,casesEnabled=false){
  const query=vi.fn(async()=>({rows:[{direction:"inbound",body:pedido.mensagem.text,sent_at:pedido.mensagem.at,status:"received"}]}));
  const pool={query} as unknown as pg.Pool;
  const log={info:vi.fn(),warn:vi.fn(),error:vi.fn()};
  const revisar=criarRevisorDePedidoDeAgenda({pool,cfg:{},tenantId:"org-a",leadId:"contato-a",conversationId:"conversa-a",jobId:"job-servidor",requestJobId,casesEnabled,log});
  return {query,pool,revisar,log};
}
beforeEach(()=>{vi.clearAllMocks();mock.ler.mockResolvedValue(contexto);mock.humano.mockResolvedValue({fingerprint:"humano-a",decisions:[]});mock.classificar.mockResolvedValue({agendaCompativel:true});});
it("cache por proposta/fotografia evita repetir conferência e sempre relê antes do efeito",async()=>{
  const b=bancada();expect(await b.revisar(proposta)).toBe(true);expect(await b.revisar(proposta)).toBe(true);
  expect(mock.classificar).toHaveBeenCalledOnce();expect(mock.ler).toHaveBeenCalledTimes(4);
  expect(b.query).toHaveBeenCalledWith(expect.stringContaining("m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3"),["org-a","contato-a","conversa-a"]);
  expect(mock.classificar.mock.calls[0]![3]).toMatchObject({agendaOperation:proposta,serviceContext:{pedido},agendaReviewRequired:true});
  expect(mock.fronteira).toHaveBeenCalledTimes(4);
});
it("decisão humana mantém fonte e invalidação por revogação; não desaparece com Caso resolvido",async()=>{
  const b=bancada(undefined,true);mock.humano.mockResolvedValueOnce({fingerprint:"humano-a",decisions:[]}).mockResolvedValueOnce({fingerprint:"humano-b",decisions:[]});
  expect(await b.revisar(proposta)).toBe(false);
  expect(mock.classificar.mock.calls[0]![3]).toMatchObject({humanDecisionContext:{fingerprint:"humano-a"}});
  expect(mock.humano).toHaveBeenCalledWith(b.pool,{tenantId:"org-a",leadId:"contato-a",conversationId:"conversa-a"},{canonicalRequest:pedido.mensagem});
});
it("mudança entre inferência e efeito invalida positivo",async()=>{
  const b=bancada();mock.ler.mockResolvedValueOnce(contexto).mockResolvedValueOnce({...contexto,fingerprint:"b"});
  expect(await b.revisar(proposta)).toBe(false);
  expect(b.log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:"agenda_request_review",sinal_positivo:true,contexto_atual:false,decisao_atual:true}));
});
it("escolha explícita de 14h40 veta 14:40Z/11h40 local mesmo se o modelo aprovar",async()=>{
  const b=bancada();
  expect(await b.revisar({...proposta,inicio:"2026-10-16T14:40:00Z",horario:"11:40",quando:"Sex 16/10 às 11:40"})).toBe(false);
  expect(mock.classificar).not.toHaveBeenCalled();
});
it("igualdade de relógio não autoriza nem evita a revisão integral",async()=>{
  const b=bancada();mock.classificar.mockResolvedValue({agendaCompativel:false});
  expect(await b.revisar(proposta)).toBe(false);expect(mock.classificar).toHaveBeenCalledOnce();
  expect(b.log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:"agenda_request_review",sinal_positivo:false,contexto_atual:true,decisao_atual:true}));
});
it("origem canônica ausente não usa o resumo do atendente nem paga rede",async()=>{
  const b=bancada();mock.ler.mockResolvedValue({...contexto,pedido:{...pedido,estado:"unavailable",mensagem:null}});
  expect(await b.revisar(proposta)).toBe(false);expect(mock.classificar).not.toHaveBeenCalled();expect(b.query).not.toHaveBeenCalled();
});
it("operador relê pedido do job de origem, sem usar declaração como consentimento",async()=>{
  const b=bancada("job-origem");expect(await b.revisar(proposta)).toBe(true);
  expect(mock.ler).toHaveBeenCalledWith(b.pool,{tenantId:"org-a",leadId:"contato-a",conversationId:"conversa-a",jobId:"job-origem"});
});
it("remarcação sem origem da reserva não paga revisão nem herda positivo",async()=>{
  const b=bancada();
  expect(await b.revisar({...proposta,acao:"remarcar"})).toBe(false);
  expect(mock.classificar).not.toHaveBeenCalled();expect(b.query).not.toHaveBeenCalled();
});
it("falha de revisão ou de fronteira não produz autorização em cache",async()=>{
  const b=bancada();mock.classificar.mockRejectedValueOnce(new Error("provedor indisponível"));
  await expect(b.revisar(proposta)).rejects.toThrow("provedor indisponível");
  expect(await b.revisar(proposta)).toBe(true);
  mock.fronteira.mockRejectedValueOnce(new Error("fronteira mudou"));
  await expect(b.revisar(proposta)).rejects.toThrow("fronteira mudou");
});

it("segunda remarcação não reutiliza aprovação ou origem da primeira",async()=>{
  const b=bancada();
  const origem={inicio:"2026-10-16T17:40:00Z",fim:"2026-10-16T18:20:00Z",fuso:"America/Sao_Paulo",dia:"2026-10-16",horario:"14:40",quando:"14h40",estado:"confirmed" as const,revisao:1};
  const primeira={...proposta,acao:"remarcar" as const,inicio:"2026-10-16T22:20:00Z",horario:"19:20",reserva_atual:origem};
  mock.ler.mockResolvedValue({...contexto,pedido:{...pedido,mensagem:{...pedido.mensagem,text:"Remarque de14h40 para19h20"}}});
  expect(await b.revisar(primeira)).toBe(true);
  const segunda={...primeira,inicio:"2026-10-16T23:40:00Z",horario:"20:40",reserva_atual:{...origem,inicio:primeira.inicio,horario:"19:20",revisao:2}};
  mock.ler.mockResolvedValue({...contexto,fingerprint:"nova-fotografia",pedido:{...pedido,mensagem:{...pedido.mensagem,text:"Agora remarque de19h20 para20h40"}}});
  mock.classificar.mockResolvedValue({agendaCompativel:false});
  expect(await b.revisar(segunda)).toBe(false);
  expect(mock.classificar).toHaveBeenCalledTimes(2);
  expect(mock.classificar.mock.calls[1]![3]).toMatchObject({agendaOperation:segunda,serviceContext:{fingerprint:"nova-fotografia"}});
});


it('pré-gravação recebe as leituras do agente e invalida a aprovação se elas mudarem', async () => {
  const b=bancada();
  let alterado=false;
  const contextoDoTurno=()=>({agentContext:{versao:1 as const,fontes:[],omitidas:0,fingerprint:alterado?'b':'a'}});
  const revisar=criarRevisorDePedidoDeAgenda({pool:b.pool,cfg:{},tenantId:'org-a',leadId:'contato-a',conversationId:'conversa-a',jobId:'job-servidor',log:b.log,contextoDoTurno});
  mock.classificar.mockImplementationOnce(async()=>{alterado=true;return {agendaCompativel:true};});
  expect(await revisar(proposta)).toBe(false);
  expect(mock.classificar.mock.calls[0]![3].agentContext.fingerprint).toBe('a');
});
