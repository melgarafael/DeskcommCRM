import { criarObservacaoDeConsultasDaAgenda } from '@/lib/agenda/consulta-do-turno';
import type pg from "pg";
import { pacoteFactualDaRevisao, precisaRevisarAgenda } from "./contrato-contexto";
import { criarObservacaoDaAgenda } from "@/lib/agenda/recibo-do-turno";
import { INSTRUCAO_RECIBO_AGENDA } from "@/lib/agenda/pedido";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({call:vi.fn()}));
vi.mock("../../edge/llm/run-model-call",()=>({runModelCall:mock.call}));
import { classifyPromise,parsePromiseClassification } from "./semantic";
import { semanticPromiseGate,factualClaimGate,type GateContext } from "../before-send";
import { decidirRevisao } from "./decisao-do-jev";
import { perguntasDaRevisao,pacoteParaJev } from "@/lib/ai/decisao/revisao-resposta";
import { normalizarFontesDoAtendimento, type ContextoDoAtendimento, type FontesDoAtendimento } from "../../agent/contexto-do-atendimento";

const log={info:vi.fn(),warn:vi.fn(),error:vi.fn()};
const pool={} as pg.Pool;
const candidate="Sua consulta está confirmada hoje às 11h40.";
const serviceContext:ContextoDoAtendimento={versao:1,fingerprint:"fotografia",perfil:[],decisoes:[],continuidade:[],cobertura:[],
  pedido:{estado:"present",tipoTurno:"inbound_turn",gatilhoEm:"2026-10-16T09:00Z",mensagem:{id:"privado",text:"Quero às 14h40 hoje, 16/10. Pode agendar para mim.",at:"2026-10-16T09:00Z",origem:"client_message"}},
  operacoes:[{id:"recibo-privado",origem:"agenda_persistida",sujeito:"contato",em:"2026-10-16T09:01Z",revisao:"1",estado:"verified",
    dados:{inicio:"2026-10-16T14:40:00Z",fuso:"America/Sao_Paulo",estado:"confirmed",publicacao_google:"synced",revisao_google_local:1,revisao_google_publicada:1}}]};
const resposta=(agendaCompativel:unknown)=>JSON.stringify({isPromise:false,suspectPhrase:null,prometeuRetornoHumano:false,retornoSoDoAssistente:false,agendaCompativel});

beforeEach(()=>{vi.clearAllMocks();mock.call.mockReset();mock.call.mockResolvedValue({result:{text:resposta(false)}});});
describe("pedido, execução e candidata são perguntas independentes",()=>{
  it("isola a candidata atual das falas do cliente e da candidata recusada, preservando todas as fontes",async()=>{
    const atual="A avaliação inicial dura 40 minutos.";
    const recusada="Você prefere durante a semana ou no sábado?";
    const args={candidate:atual,agendaReviewRequired:true,serviceContext,
      pendingAgendaCommunication:{candidate:recusada,code:"agenda_request_mismatch"}};
    mock.call.mockResolvedValue({result:{text:resposta(true)}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},args,{log});
    expect(v.agendaCompativel).toBe(true);
    const request=mock.call.mock.calls[1]![2];
    expect(request.messages).toHaveLength(2);
    const fontes=JSON.parse(request.messages[0].content);
    expect(fontes).toEqual(pacoteFactualDaRevisao(args));
    expect(fontes.comunicacao_agenda_pendente.candidata_recusada).toBe(recusada);
    expect(fontes.contexto_atendimento.pedido_canonico.mensagem.texto).toContain("14h40");
    expect(JSON.parse(request.messages[1].content)).toEqual({
      alvo_da_revisao:"candidata_atual_do_atendente",candidata_atual:fontes.mensagem,
    });
    expect(request.messages[1].content).not.toContain(recusada);
    expect(request.messages[1].content).not.toContain("Quero às 14h40");
    expect(request.system).toContain("Um horário pedido estar indisponível não veta uma resposta");
    expect(mock.call).toHaveBeenCalledTimes(2);
  });
  it("autoriza proposta nova sem exigir recibo prévio, conservando o cancelamento histórico e a cobertura",async()=>{
    const proposal={acao:"criar" as const,servico:"Consulta",inicio:"2026-10-16T17:40:00Z",fuso:"America/Sao_Paulo",dia:"2026-10-16",horario:"14:40",quando:"Sex 16/10 às 14:40",beneficiarios:["contato_atendido"]};
    const contexto:ContextoDoAtendimento={...serviceContext,
      cobertura:[{categoria:"perfil",estado:"excluded_by_limit",encontrados:3,selecionados:2,omitidos:1}],
      operacoes:[{...serviceContext.operacoes[0]!,dados:{...serviceContext.operacoes[0]!.dados,estado:"cancelled",publicacao_google:"removed"}}]};
    mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":true}'}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},{candidate:"",agendaOperation:proposal,serviceContext:contexto},{log});
    expect(v.agendaCompativel).toBe(true);
    const request=mock.call.mock.calls[0]![2];
    const packet=JSON.parse(request.messages[0].content);
    expect(packet).toMatchObject({mensagem:"",fase_agenda:"antes_da_escrita",operacao_proposta:proposal});
    expect(packet.contexto_atendimento.operacoes[0].dados.estado).toBe("cancelled");
    expect(packet.contexto_atendimento.cobertura[0].estado).toBe("excluded_by_limit");
    expect(request.system).toContain('SOMENTE UM objeto JSON: {"agendaCompativel":true|false}');
    expect(request.system).toContain("Não exigir execução prévia da nova sessão");
    expect(request.system).not.toContain("DUAS perguntas INDEPENDENTES");
    expect(log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:"agenda_review_signal",fase:"antes_da_escrita",sinal:"positive"}));
  });
  it("envio honesto sem afirmar reserva passa a pergunta de agenda; mantém contrato completo e promessa humana",async()=>{
    mock.call.mockResolvedValue({result:{text:JSON.stringify({agendaCompativel:true,isPromise:false,prometeuRetornoHumano:true,retornoSoDoAssistente:false})}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},
      {candidate:"Encaminhei seu pedido para análise da equipe. Ainda não há reserva confirmada.",serviceContext},
      {log,loadHumanReturnBinding:vi.fn(async()=>null) as never});
    expect(v).toMatchObject({agendaCompativel:true,prometeuRetornoHumano:true,retornoSoDoAssistente:false});
    expect(mock.call).toHaveBeenCalledTimes(2);
    expect(mock.call.mock.calls[0]![2].system).not.toContain('"agendaCompativel":true|false');
    expect(mock.call.mock.calls[1]![2].system).toContain("Sua pergunta NÃO é se o pedido original foi atendido");
    expect(mock.call.mock.calls[0]![2].system).toContain(INSTRUCAO_RECIBO_AGENDA);
    expect(mock.call.mock.calls[1]![2].system).toContain(INSTRUCAO_RECIBO_AGENDA);
    expect(perguntasDaRevisao(false,false,true).agenda?.instrucao).toContain(INSTRUCAO_RECIBO_AGENDA);
    expect(mock.call.mock.calls[1]![2].system).toContain('"agendaCompativel":true|false');
    expect(log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:"agenda_review_normalized",sinal_positivo:true,pacote_excluido:false,compativel:true}));
  });
  it("reserva da pergunta de agenda ausente não herda positivo incidental da revisão comercial",async()=>{
    mock.call.mockResolvedValueOnce({result:{text:resposta(true)}}).mockResolvedValueOnce({result:{text:'{}'}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a",leadId:"contato-a",jobId:"job-a"},
      {candidate,serviceContext,model:"auxiliar",llmOverride:{provider:"anthropic"}},{log});
    expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:"sinal_invalido"});
    expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:"agenda_review_inconclusive"});
    const chamadas=mock.call.mock.calls.map(c=>c[2]);
    expect(chamadas).toHaveLength(2);
    for(const chamada of chamadas) expect(chamada).toMatchObject({tenantId:"org-a",leadId:"contato-a",jobId:"job-a",purpose:"promise_semantic",model:"auxiliar",llmOverride:{provider:"anthropic"}});
    expect(chamadas[1]!.messages[0]).toEqual(chamadas[0]!.messages[0]);
    expect(chamadas[1]!.messages).toHaveLength(2);
    expect(JSON.parse(chamadas[1]!.messages[1].content)).toEqual({
      alvo_da_revisao:"candidata_atual_do_atendente",candidata_atual:candidate,
    });
  });
  it("recibo real não libera operação não solicitada; sinal chega ao gate",async()=>{
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},{candidate,serviceContext},{log});
    expect(v).toMatchObject({isPromise:false,agendaCompativel:false});
    expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:"agenda_request_mismatch"});
    const request=mock.call.mock.calls[1]![2];
    const packet=JSON.parse(request.messages[0].content);
    expect(packet.contexto_atendimento.pedido_canonico.mensagem.texto).toContain("14h40");
    expect(packet.contexto_atendimento.operacoes[0].dados.inicio).toBe("2026-10-16T14:40:00Z");
    expect(request.system).toContain("17:40Z corresponde, 14:40Z é 11h40");
    expect(request.system).toContain("recibo comprova a execução, não a autorização");
    expect(request.system).not.toContain(serviceContext.pedido!.mensagem!.text);
  });
  it.each([undefined,null,"true",1,{},false])("ausência/coerção não aprova agenda: %j",async value=>{
    mock.call.mockResolvedValue({result:{text:resposta(value)}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},{candidate,serviceContext},{log});
    expect(v.agendaCompativel).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:"agenda_review_signal",sinal:typeof value==="boolean"?"negative":"absent_or_invalid"}));
    expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false});
  });
  it("positivo estrito não desliga veto comercial",()=>{
    const v=parsePromiseClassification(JSON.stringify({agendaCompativel:true,isPromise:true,suspectPhrase:"Plano grátis para sempre"}),candidate);
    expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:"promise_semantic"});
    expect(semanticPromiseGate.evaluate({semanticPromise:{...v,isPromise:false},agendaRequestReviewRequired:true} as GateContext)).toEqual({pass:true});
  });
  it("exclusão do pacote por limite não transforma resposta positiva em autorização",async()=>{
    mock.call.mockResolvedValue({result:{text:resposta(true)}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},{candidate,serviceContext,
      commercialEvidence:[{origem:"conhecimento",referencia:"fonte",titulo:"Condições",conteudo:"condição ".repeat(10000)}]},{log});
    expect(v.agendaCompativel).toBe(false);
  });
  it.each([true,false])("confirmador humano opcional conserva o julgamento independente da agenda: %s",async agendaCompativel=>{
    mock.call.mockResolvedValueOnce({result:{text:JSON.stringify({isPromise:false,prometeuRetornoHumano:true,retornoSoDoAssistente:false,agendaCompativel})}})
      .mockResolvedValueOnce({result:{text:JSON.stringify({agendaCompativel})}})
      .mockResolvedValueOnce({result:{text:'{"prometeuRetornoHumano":false,"retornoSoDoAssistente":false}'}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},{candidate,serviceContext},
      {log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:"human_return_confirmation"})) as never});
    expect(v.agendaCompativel).toBe(agendaCompativel);
    expect(mock.call).toHaveBeenCalledTimes(3);
    const packet=JSON.parse(mock.call.mock.calls[2]![2].messages[0].content);
    expect(packet.contexto_atendimento.pedido_canonico.mensagem.texto).toContain("14h40");
  });
  it("fora do fluxo agenda os chamadores legados conservam o contrato",()=>{
    expect(semanticPromiseGate.evaluate({semanticPromise:null} as GateContext)).toEqual({pass:true});
    expect(semanticPromiseGate.evaluate({semanticPromise:null,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false});
  });
  it("não conferido informa o motivo sem mudar a política factual nem registrar texto",()=>{
    expect(factualClaimGate.evaluate({factualClaim:{estado:"nao_conferida",veredito:"nao_conferido",motivo:"desligada",frase:null,quantidadeDeFrases:0,pediu:false}} as GateContext))
      .toEqual({pass:true,skipped:"nao_conferido",detail:{motivo:"desligada"}});
  });
  it("remarcação transporta origem e destino distintos no pacote comum, sem inferir consentimento",async()=>{
    const proposal={acao:"remarcar" as const,servico:"Consulta",inicio:"2026-10-16T22:20:00Z",fuso:"America/Sao_Paulo",
      dia:"2026-10-16",horario:"19:20",quando:"Sex 16/10 às 19:20",beneficiarios:["contato_atendido"],
      reserva_atual:{inicio:"2026-10-16T17:40:00Z",fim:"2026-10-16T18:20:00Z",fuso:"America/Sao_Paulo",
        dia:"2026-10-16",horario:"14:40",quando:"Sex 16/10 às 14:40",estado:"confirmed" as const,revisao:1}};
    mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":true}'}});
    const args={candidate:"",agendaOperation:proposal,serviceContext};
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},args,{log});
    expect(v.agendaCompativel).toBe(true);
    expect(JSON.parse(mock.call.mock.calls[0]![2].messages[0].content)).toEqual(pacoteParaJev(args));
    expect(pacoteParaJev(args).operacao_proposta).toEqual(proposal);
    expect(mock.call.mock.calls[0]![2].system).toContain("ORIGEM relida no servidor");
  });
  it("JEV recebe mesma proposta/fuso, sem transformar instantâneo em escolha humana",()=>{
    const proposal={acao:"criar" as const,servico:"Consulta",inicio:"2026-10-16T17:40:00Z",fuso:"America/Sao_Paulo",dia:"2026-10-16",horario:"14:40",quando:"Sex 16/10 às 14:40",beneficiarios:["contato_atendido"]};
    const packet=pacoteParaJev({candidate:"",serviceContext,agendaOperation:proposal});
    expect(packet.operacao_proposta).toEqual(proposal);expect(packet.fase_agenda).toBe("antes_da_escrita");
    const q=perguntasDaRevisao(false,false,true).agenda!;
    expect(q.instrucao).toContain("Disponibilidade, existência da reserva e publicação Google NÃO provam");
    expect(q.instrucao).not.toContain("Inclua agendaCompativel");
    const base={comercial:{tipo:"noul" as const,noul:0.01},retorno:{tipo:"noul" as const,noul:0.01},so_assistente:{tipo:"noul" as const,noul:0.01}};
    expect(decidirRevisao({...base,agenda:{tipo:"noul",noul:0.99}},false,true)).toMatchObject({motivo:"decidiu",veredito:{agendaCompativel:true}});
    expect(decidirRevisao({...base,agenda:{tipo:"noul",noul:0.01}},false,true)).toMatchObject({motivo:"decidiu",veredito:{agendaCompativel:false}});
    expect(decidirRevisao({...base,agenda:{tipo:"noul",noul:0.5}},false,true)).toMatchObject({motivo:"duvida",campo:"agenda"});
    expect(decidirRevisao(base,false,true)).toMatchObject({motivo:"resposta_ilegivel",campo:"agenda"});
  });
});


describe("recibo observado no turno e releitura comum aos revisores",()=>{
  const contexto:ContextoDoAtendimento={...serviceContext,operacoes:[
    {...serviceContext.operacoes[0]!,id:"antiga-privada",dados:{estado:"cancelled",revisao_reserva:2,inicio_local:"2026-10-16T14:40:00-03:00"}},
    {...serviceContext.operacoes[0]!,id:"atual-privada",dados:{estado:"cancelled",revisao_reserva:4,inicio_local:"2026-10-16T19:20:00-03:00",natureza_cancelamento:"cancelamento_sincronizado_no_google",publicacao_google:"removed",revisao_google_local:4,revisao_google_publicada:4,publicacao_pendente:false}},
  ]};
  const args={candidate:"Sua sessão das19h20 foi cancelada.",serviceContext:contexto,
    agendaOperationReceipt:{acao:"cancelar" as const,reservaId:"atual-privada",revisao:4},
    pendingAgendaCommunication:{candidate:"Continua confirmada.",code:"agenda_request_mismatch"}};
  it("não usa recibo antigo nem apaga histórico; não exporta a identidade privada",()=>{
    const packet=pacoteFactualDaRevisao(args);
    expect(packet).toEqual(pacoteParaJev(args));
    expect(packet.resultado_agenda_do_turno).toMatchObject({acao_observada:"cancelar",referencia_recibo:"fonte_2",revisao_relida:4,
      recibo:{estado:"cancelled",inicio_local:"2026-10-16T19:20:00-03:00",publicacao_google:"removed"}});
    expect((packet.contexto_atendimento as {operacoes:unknown[]}).operacoes).toHaveLength(2);
    expect(JSON.stringify(packet)).not.toContain("atual-privada");
    expect(JSON.stringify(packet)).not.toContain("antiga-privada");
  });
  it("JEV, reserva da agenda e confirmador recebem o mesmo vínculo sem substituir seus sinais",async()=>{
    mock.call.mockResolvedValueOnce({result:{text:JSON.stringify({isPromise:false,prometeuRetornoHumano:true,retornoSoDoAssistente:false})}})
      .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}})
      .mockResolvedValueOnce({result:{text:'{"prometeuRetornoHumano":false,"retornoSoDoAssistente":false}'}});
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},args,
      {log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:"human_return_confirmation"})) as never});
    expect(v.agendaCompativel).toBe(true);
    expect(mock.call).toHaveBeenCalledTimes(3);
    for(const call of mock.call.mock.calls)expect(JSON.parse(call[2].messages[0].content)).toEqual(pacoteParaJev(args));
  });
  it("vínculo não substitui a resposta negativa do classificador",async()=>{
    const v=await classifyPromise(pool,{}, {tenantId:"org-a"},args,{log});
    expect(v.agendaCompativel).toBe(false);
    expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:"agenda_request_mismatch"});
  });
  it("exclusão global remove também o vínculo e não aproveita o sinal positivo",async()=>{
    const a={...args,commercialEvidence:[{origem:"conhecimento" as const,referencia:"fonte",titulo:"Condições",conteudo:"condição ".repeat(10000)}]};
    mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":true,"isPromise":false,"prometeuRetornoHumano":false}'}});
    const packet=pacoteFactualDaRevisao(a);expect(packet.limite_contexto).toBe(true);expect(packet.resultado_agenda_do_turno).toBeUndefined();
    expect(await classifyPromise(pool,{}, {tenantId:"org-a"},a,{log})).toMatchObject({agendaCompativel:false,agendaReviewIssue:"contexto_incompleto"});
    expect(mock.call).not.toHaveBeenCalled();
  });
});

it('observação de operação ainda exige pergunta de agenda se a releitura falhar',()=>{
 const a={candidate:'Foi cancelada.',agendaOperationReceipt:{acao:'cancelar' as const,reservaId:'privada',revisao:2}};
 expect(precisaRevisarAgenda(a)).toBe(true);expect(pacoteFactualDaRevisao(a).resultado_agenda_do_turno).toBeUndefined();
});


describe("pendência original do Caso não é decisão humana global",()=>{
  const org="11111111-1111-4111-8111-111111111111";
  const contact="22222222-2222-4222-8222-222222222222";
  const at="2026-11-23T12:00:00Z";
  const row=(id:string)=>({id,organization_id:org,contact_id:contact,created_at:at});
  const proposal={acao:"criar" as const,servico:"Consulta",inicio:"2026-11-23T17:40:00Z",fuso:"America/Sao_Paulo",
    dia:"2026-11-23",horario:"14:40",quando:"23/11 às 14:40",beneficiarios:["contato_atendido"]};
  function contexto(text="Quero uma nova consulta para mim em 23/11 às 14h40. Pode agendar."){
    const fontes:FontesDoAtendimento={contato:row(contact),negocios:[],notas:[],atividades:[],propostas:[],retornos:[],
      agenda:[{...row("reserva-antiga"),status:"cancelled",starts_at:"2026-11-20T17:40:00Z",ends_at:"2026-11-20T18:20:00Z",
        time_zone:"America/Sao_Paulo",cancelled_at:"2026-11-20T13:00:00Z",revision:2,google_publication:"removed",
        google_local_revision:2,google_synced_local_revision:2,needs_google_push:false,google_sync_error:null}],
      caso:[{...row("caso-antigo"),status:"awaiting_human",title:"Remarcar a consulta anterior",summary:"Pendência da alteração de 20/11",
        blocker:"A operação não foi concluída; a equipe precisa ajustar a mesma reserva sem criar uma nova.",
        original_request:"Remarque minha consulta de 20/11 das 14h40 para 19h20.",human_ask:null,lead_update:null}],
      job:{...row("job-atual"),kind:"inbound_turn",canonical_message:{id:"pedido-atual",text,at,origem:"client_message"}},
      conversa:row("conversa-atual")};
    return normalizarFontesDoAtendimento(fontes,org);
  }
  it("mantém o Caso, o bloqueio e o histórico cancelado com autoridade delimitada, sem exigir origem para criar",async()=>{
    const serviceContext=contexto();
    mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":true}'}});
    const args={candidate:"",agendaOperation:proposal,serviceContext};
    expect((await classifyPromise(pool,{}, {tenantId:org},args,{log})).agendaCompativel).toBe(true);
    const request=mock.call.mock.calls[0]![2];const packet=JSON.parse(request.messages[0].content);
    expect(packet).toEqual(pacoteParaJev(args));
    expect(packet.operacao_proposta.reserva_atual).toBeUndefined();
    expect(packet.contexto_atendimento.decisoes).toEqual([]);
    expect(packet.contexto_atendimento.continuidade.find((f:{origem:string})=>f.origem==='caso_humano').dados).toMatchObject({
      estado:"awaiting_human",titulo:"Remarcar a consulta anterior",bloqueio:expect.stringContaining("sem criar uma nova"),
      pedido_original:expect.stringContaining("20/11"),pergunta_humana:null,
      natureza:"pendencia_operacional_do_pedido_original",autoridade:"nao_atesta_decisao_humana_nem_veto_global",
      alcance:"pendencia_do_pedido_original_nao_aprovacao_de_outro_pedido"});
    expect(packet.contexto_atendimento.operacoes[0].dados).toMatchObject({estado:"cancelled",publicacao_google:"removed"});
    expect(packet.contexto_atendimento.pedido_canonico.mensagem.texto).toContain("nova consulta para mim em 23/11 às 14h40");
    expect(request.system).toContain("caso_humano identifica o fluxo de trabalho, não a autoria de uma decisão");
    expect(request.system).toContain("Na ação criar, reserva_atual não é exigida");
    expect(perguntasDaRevisao(false,false,true).agenda!.instrucao).toContain("caso_humano identifica o fluxo de trabalho");
  });
  it("reserva e confirmador recebem a mesma continuidade delimitada do JEV sem apagar uma decisão humana pertinente",async()=>{
    const args={candidate:"Vou pedir à equipe para conferir a consulta.",serviceContext:contexto(),humanDecisionContext:{
      versao:1 as const,fingerprint:"privada",limited:false,
      currentRequest:{id:"pedido-atual",text:"Quero uma nova consulta para mim em 23/11 às 14h40.",at},
      decisions:[{eventId:"evento-autenticado",caseId:"caso-pertinente",jobId:"job-humano",action:"resolved" as const,
        note:"Não agendar esta consulta antes da avaliação individual da equipe.",at,title:"Consulta de 23/11",summary:"Avaliação necessária",
        blocker:"Aguardar avaliação",requestId:"pedido-atual",request:"Quero uma consulta em 23/11 às 14h40.",
        provenance:"authenticated" as const,eligible:true}]} };
    mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}'}})
      .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}})
      .mockResolvedValueOnce({result:{text:'{"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}'}});
    await classifyPromise(pool,{}, {tenantId:org},args,{log,
      loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:"human_return_confirmation"})) as never});
    expect(mock.call).toHaveBeenCalledTimes(3);
    for(const call of mock.call.mock.calls){
      const packet=JSON.parse(call[2].messages[0].content);expect(packet).toEqual(pacoteParaJev(args));
      expect(packet.contexto_decisoes.decisoes[0]).toMatchObject({elegivel:true,nota:args.humanDecisionContext.decisions[0]!.note});
      expect(packet.contexto_atendimento.continuidade[0].dados.autoridade).toBe("nao_atesta_decisao_humana_nem_veto_global");
      expect(call[2].system).toContain("Pedido novo não revoga decisão humana autenticada ainda pertinente");
    }
  });
  it.each([
    ["beneficiário divergente","Quero uma nova consulta para minha filha Lia em 23/11 às 14h40.",proposal],
    ["data divergente","Quero uma nova consulta para mim em 24/11 às 14h40.",proposal],
    ["destino divergente","Remarque minha consulta de 23/11 das 10h para 19h20.",{...proposal,acao:"remarcar" as const,
      reserva_atual:{inicio:"2026-11-23T13:00:00Z",fim:"2026-11-23T13:40:00Z",fuso:"America/Sao_Paulo",dia:"2026-11-23",horario:"10:00",quando:"23/11 às 10:00",estado:"confirmed" as const,revisao:2}}],
    ["origem antiga após remarcação","Remarque a consulta atual de 23/11 das 14h40 para 19h20.",{...proposal,acao:"remarcar" as const,inicio:"2026-11-23T22:20:00Z",horario:"19:20",
      reserva_atual:{inicio:"2026-11-23T13:00:00Z",fim:"2026-11-23T13:40:00Z",fuso:"America/Sao_Paulo",dia:"2026-11-23",horario:"10:00",quando:"23/11 às 10:00",estado:"confirmed" as const,revisao:1}}],
    ["pedido ambíguo","Talvez seja para mim ou para Lia, às 14h40 ou 19h20.",proposal],
  ])("Caso antigo não libera %s nem apaga o pedido para a revisão",async(_name,text,agendaOperation)=>{
    const serviceContext=contexto(text);const args={candidate:"",serviceContext,agendaOperation};
    // Sinal controlado verifica transporte e composição; não mede acurácia do modelo.
    mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":false}'}});
    const verdict=await classifyPromise(pool,{}, {tenantId:org},args,{log});
    expect(verdict.agendaCompativel).toBe(false);
    expect(semanticPromiseGate.evaluate({semanticPromise:verdict,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:"agenda_request_mismatch"});
    const packet=JSON.parse(mock.call.mock.calls[0]![2].messages[0].content);
    expect(packet.contexto_atendimento.pedido_canonico.mensagem.texto).toBe(text);
    expect(packet.operacao_proposta).toEqual(agendaOperation);
    expect(packet.contexto_atendimento.continuidade[0].dados.pedido_original).toContain("20/11");
  });
  it("restrição humana autenticada pertinente continua no julgamento de uma criação nova",async()=>{
    const humanDecisionContext={versao:1 as const,fingerprint:"decisao-atual",limited:false,
      currentRequest:{id:"pedido-atual",text:"Quero uma nova consulta para mim em 23/11 às 14h40.",at},
      decisions:[{eventId:"evento",caseId:"caso",jobId:"job",action:"resolved" as const,
        note:"Não agendar esta consulta antes da avaliação individual da equipe.",at,title:"Avaliação",summary:"Restrição vigente",
        blocker:"Aguardar avaliação",requestId:"pedido-atual",request:"Quero uma consulta em 23/11 às 14h40.",
        provenance:"authenticated" as const,eligible:true}]};
    const args={candidate:"",serviceContext:contexto(),agendaOperation:proposal,humanDecisionContext};
    const v=await classifyPromise(pool,{}, {tenantId:org},args,{log});
    expect(v.agendaCompativel).toBe(false);
    const packet=JSON.parse(mock.call.mock.calls[0]![2].messages[0].content);
    expect(packet.contexto_decisoes.decisoes[0]).toMatchObject({elegivel:true,nota:humanDecisionContext.decisions[0]!.note});
    expect(mock.call.mock.calls[0]![2].system).toContain("Pedido novo não revoga decisão humana autenticada ainda pertinente");
  });
  it.each([undefined,null,"true"])('pedido explícito e Caso antigo não substituem sinal estrito: %s',async sinal=>{
    mock.call.mockResolvedValue({result:{text:JSON.stringify({agendaCompativel:sinal})}});
    const v=await classifyPromise(pool,{}, {tenantId:org},{candidate:"",serviceContext:contexto(),agendaOperation:proposal},{log});
    expect(v.agendaCompativel).toBe(false);
  });
});


describe('revisão depois da remarcação usa transição e destino atuais',()=>{
 const context:ContextoDoAtendimento={...serviceContext,pedido:{...serviceContext.pedido!,mensagem:{...serviceContext.pedido!.mensagem!,text:'Remarque minha consulta de 23/11 das 10h para 14h40.'}},
  operacoes:[{...serviceContext.operacoes[0]!,id:'mesma-reserva',dados:{estado:'confirmed',revisao_reserva:2,inicio:'2026-11-23T17:40:00Z',fim:'2026-11-23T18:20:00Z',fuso:'America/Sao_Paulo',publicacao_google:'synced',revisao_google_local:2,revisao_google_publicada:2}},
   {...serviceContext.operacoes[0]!,id:'outra-cancelada',dados:{estado:'cancelled',revisao_reserva:2,inicio:'2026-11-23T17:40:00Z',publicacao_google:'removed'}}]};
 function args(){
  const o=criarObservacaoDaAgenda();o.concluir(o.iniciar(),'crm_reschedule_appointment',{remarcado:true,
   origem_remarcacao:{reserva_id:'mesma-reserva',inicio:'2026-11-23T13:00:00Z',fim:'2026-11-23T13:40:00Z',fuso:'America/Sao_Paulo',estado:'confirmed',revisao:1},
   compromisso:{id:'mesma-reserva',starts_at:'2026-11-23T17:40:00Z',ends_at:'2026-11-23T18:20:00Z',time_zone:'America/Sao_Paulo',status:'confirmed',revision:2}});
  return {candidate:'Sua consulta foi remarcada para 23/11 às 14h40.',serviceContext:context,agendaOperationReceipt:o.atual()};
 }
 it('JEV, reserva e confirmador recebem a fase posterior e o mesmo vínculo sem confundir outro cancelamento',async()=>{
  const a=args();mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}'}})
   .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}}).mockResolvedValueOnce({result:{text:'{"prometeuRetornoHumano":false,"retornoSoDoAssistente":false}'}});
  expect((await classifyPromise(pool,{}, {tenantId:'org'},a,{log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never})).agendaCompativel).toBe(true);
  expect(mock.call).toHaveBeenCalledTimes(3);
  for(const call of mock.call.mock.calls){
   const p=JSON.parse(call[2].messages[0].content);expect(p).toEqual(pacoteParaJev(a));
   expect(p).toMatchObject({fase_agenda:'depois_da_escrita',resultado_agenda_do_turno:{referencia_recibo:'fonte_1',transicao_remarcacao:{mesma_reserva:true,origem:{revisao:1},destino:{revisao:2}}}});
   expect(p.contexto_atendimento.operacoes[1]).toMatchObject({referencia:'fonte_2',dados:{estado:'cancelled'}});
   expect(JSON.stringify(p)).not.toContain('mesma-reserva');expect(JSON.stringify(p)).not.toContain('outra-cancelada');
  }
  expect(mock.call.mock.calls[1]![2].system).toContain('não exigir que a origem anterior continue como horário atual');
 });
 it('prova de transição não substitui um veto independente nem dispensa pedido/candidata corretos',async()=>{
  const a=args();const v=await classifyPromise(pool,{}, {tenantId:'org'},a,{log});
  expect(v.agendaCompativel).toBe(false);expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false});
 });
 it('consulta de estado em outra entrada não inventa uma transição de turno anterior',()=>{
  const p=pacoteParaJev({candidate:'Sua consulta consta para 23/11 às 14h40.',serviceContext:context});
  expect(p.resultado_agenda_do_turno).toBeUndefined();expect(p.fase_agenda).toBeUndefined();
 });
});


describe('revisão por fase e saída contraditória',()=>{
 const proposal={acao:'criar' as const,servico:'Consulta',inicio:'2026-10-16T17:40:00Z',fuso:'America/Sao_Paulo',dia:'2026-10-16',horario:'14:40',quando:'16/10 às 14:40',beneficiarios:['contato_atendido'],politica_do_servico:{confirmacao_equipe_exigida:false,revisao_regra:4}};
 it.each([
  '{"agendaCompativel":true}\nCorreção: {"agendaCompativel":false}',
  '{"agendaCompativel":false}\nCorreção: {"agendaCompativel":true}',
 ])('proposta contraditória não autoriza escrita: %s',async text=>{
  mock.call.mockResolvedValue({result:{text}});
  const v=await classifyPromise(pool,{}, {tenantId:'org'},{candidate:'',agendaOperation:proposal,serviceContext},{log});
  expect(v.agendaCompativel).toBe(false);expect(log.warn).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:'agenda_review_ambiguous_output'}));
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false});
 });
 it('envio contraditório não herda positivo da revisão comercial nem do primeiro objeto',async()=>{
  mock.call.mockResolvedValueOnce({result:{text:resposta(true)}}).mockResolvedValueOnce({result:{text:'{"agendaCompativel":true} depois {"agendaCompativel":false}'}});
  expect((await classifyPromise(pool,{}, {tenantId:'org'},{candidate,serviceContext},{log})).agendaCompativel).toBe(false);
  expect(mock.call).toHaveBeenCalledTimes(2);
 });
 it('reserva recebe critério anterior à escrita e mantém regra de serviço, pedido e demais fontes',async()=>{
  mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":true}'}});
  const args={candidate:'',agendaOperation:proposal,serviceContext};
  expect((await classifyPromise(pool,{}, {tenantId:'org'},args,{log})).agendaCompativel).toBe(true);
  const req=mock.call.mock.calls[0]![2];const packet=JSON.parse(req.messages[0].content);
  expect(packet).toEqual(pacoteParaJev(args));expect(packet.operacao_proposta.politica_do_servico).toEqual(proposal.politica_do_servico);
  expect(req.system).toContain('não julga uma confirmação de resultado futuro');
  expect(req.system).not.toContain('Se comunicacao_agenda_pendente estiver presente');
  expect(req.system).toContain('não cria uma nova regra de aprovação');
  expect(req.system).toContain('decisão humana autenticada pertinente');
  expect(perguntasDaRevisao(false,false,true,true).agenda!.instrucao).toContain('não julga uma confirmação de resultado futuro');
  expect(perguntasDaRevisao(false,false,true,true).agenda!.instrucao).not.toContain('SOMENTE UM objeto JSON');
 });
 it.each([false,true])('regra de confirmação %s não substitui o sinal do revisor',async required=>{
  mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":false}'}});
  const v=await classifyPromise(pool,{}, {tenantId:'org'},{candidate:'',serviceContext,agendaOperation:{...proposal,politica_do_servico:{...proposal.politica_do_servico,confirmacao_equipe_exigida:required}}},{log});
  expect(v.agendaCompativel).toBe(false);
 });
});


describe('envio com síntese anterior e veto de comunicação',()=>{
 const current:ContextoDoAtendimento={...serviceContext,pedido:{...serviceContext.pedido!,mensagem:{...serviceContext.pedido!.mensagem!,text:'Remarque minha consulta de23/11 das10h para14h40.'}},
  operacoes:[{...serviceContext.operacoes[0]!,id:'reserva-atual',dados:{estado:'confirmed',revisao_reserva:2,inicio:'2026-11-23T17:40:00Z',fim:'2026-11-23T18:20:00Z',fuso:'America/Sao_Paulo',publicacao_google:'synced',revisao_google_local:2,revisao_google_publicada:2,natureza_confirmacao:'reserva_publicada_sem_aprovacao_humana_exigida'}}]};
 function args(){
  const obs=criarObservacaoDaAgenda();obs.concluir(obs.iniciar(),'crm_reschedule_appointment',{remarcado:true,origem_remarcacao:{reserva_id:'reserva-atual',inicio:'2026-11-23T13:00:00Z',fim:'2026-11-23T13:40:00Z',fuso:'America/Sao_Paulo',estado:'confirmed',revisao:1},compromisso:{id:'reserva-atual',starts_at:'2026-11-23T17:40:00Z',ends_at:'2026-11-23T18:20:00Z',time_zone:'America/Sao_Paulo',status:'confirmed',revision:2}});
  return {candidate:'Sua consulta foi remarcada de10h para14h40.',serviceContext:current,agendaOperationReceipt:obs.atual(),pendingAgendaCommunication:{candidate:'Sua consulta foi remarcada para14h40.',code:'agenda_request_mismatch'},conversationContext:{mensagens:[],resumo:'RESULTADO DESTE TURNO: criação anterior às10h.Próximo passo:formulário.',limitado:false,momento:'2026-11-23T10:00:00Z',fuso:'America/Sao_Paulo'}};
 }
 it('JEV e reserva recebem papéis explícitos das fontes, preservando pedido, transição e candidata',async()=>{
  const a=args();mock.call.mockResolvedValueOnce({result:{text:JSON.stringify({isPromise:false,prometeuRetornoHumano:false,afirmouConclusaoHumana:false})}}).mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}});
  expect((await classifyPromise(pool,{}, {tenantId:'org'},a,{log})).agendaCompativel).toBe(true);
  const expected=pacoteParaJev(a);expect(expected.proveniencia_contexto).toMatchObject({resumo_conversa:{estado_operacional_revalidado:false},tentativa_anterior:{comprova_falha_da_execucao:false},resultado_atual:{natureza:'recibo_relido_servidor'}});
  for(const call of mock.call.mock.calls)expect(JSON.parse(call[2].messages[0].content)).toEqual(expected);
  expect(expected.resultado_agenda_do_turno).toMatchObject({revisao_relida:2,transicao_remarcacao:{mesma_reserva:true,origem:{revisao:1},destino:{revisao:2}}});
  expect(expected.contexto_conversa).toEqual(a.conversationContext);expect(expected.comunicacao_agenda_pendente).toMatchObject({candidata_recusada:a.pendingAgendaCommunication.candidate});
  const instruction=mock.call.mock.calls[1]![2].system;
  expect(instruction).toContain('diagnóstico de uma tentativa de ENVIO vetada, não falha/veto da execução');
  expect(instruction).toContain('não substitui o pedido canônico');
  expect(instruction).not.toContain('Se operacao_proposta está presente, julgue ANTES');
  expect(perguntasDaRevisao(false,false,true).agenda!.instrucao).toContain('diagnóstico de uma tentativa de ENVIO vetada, não falha/veto da execução');
  expect(perguntasDaRevisao(false,false,true).agenda!.instrucao).not.toContain('SOMENTE UM objeto JSON');
 });
 it('nova qualificação das fontes não transforma um negativo do revisor em autorização',async()=>{
  mock.call.mockResolvedValue({result:{text:'{"agendaCompativel":false}'}});
  const verdict=await classifyPromise(pool,{}, {tenantId:'org'},args(),{log});
  expect(verdict.agendaCompativel).toBe(false);expect(semanticPromiseGate.evaluate({semanticPromise:verdict,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false});
 });
});


describe('contexto recebido em cada etapa da mesma reserva sob histórico misto',()=>{
 const org='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222';
 const row=(id:string)=>({id,organization_id:org,contact_id:contact,created_at:'2026-11-20T10:00:00Z',updated_at:'2026-11-24T20:00:00Z'});
 function fontes(remarcacoes:number,cancelada:boolean){
  const revision=1+remarcacoes+Number(cancelada),inicio=['2026-11-23T13:00:00Z','2026-11-23T17:40:00Z','2026-11-23T22:20:00Z'][remarcacoes]!;
  const atual={...row('reserva-atual-privada'),created_at:'2026-11-23T09:00:00Z',updated_at:'2026-11-24T19:00:00Z',title:'Sessão experimental da pessoa atendida',
   status:cancelada?'cancelled':'confirmed',starts_at:inicio,ends_at:new Date(Date.parse(inicio)+40*60000).toISOString(),time_zone:'America/Sao_Paulo',
   cancelled_at:cancelada?'2026-11-23T12:00:00Z':null,revision,google_local_revision:revision,google_synced_local_revision:revision,
   google_publication:cancelada?'removed':'synced',needs_google_push:false,google_sync_error:null,google_sync_failure_kind:null,
   service_occurrence_id:'ocorrencia',service_booking_mode:'collective_unlimited',participant_name:'Pessoa atendida',service_capacity_rule:'inherit',
   service_capacity_limit:null,service_rule_revision:3,current_service_revision:3,service_requires_confirmation:false,service_human_confirmed:false,service_confirmed_at:null};
  // O sincronizador pode tocar updated_at de cancelamentos anteriores depois da reserva vigente.
  const antigas=[0,1,2,3].map(i=>({...atual,...row(`antiga-${i}-privada`),title:'Sessão experimental da pessoa atendida',status:'cancelled',
   starts_at:inicio,cancelled_at:`2026-11-2${i%2}T12:00:00Z`,google_publication:'removed',revision:2,google_local_revision:2,google_synced_local_revision:2}));
  const pedido=cancelada?'Cancele a minha reserva atual.':remarcacoes?'Remarque a mesma reserva para o novo horário solicitado.':'Pode agendar minha primeira sessão.';
  const f:FontesDoAtendimento={contato:row(contact),negocios:[],notas:[],atividades:[],propostas:[],retornos:[],caso:[],agenda:[...antigas,atual],
   job:{...row('job'),kind:'inbound_turn',canonical_message:{id:'mensagem-atual-privada',text:pedido,at:'2026-11-23T11:59:00Z',origem:'client_message'}},conversa:row('conversa')};
  return {f,atual,pedido,revision};
 }
 it.each([
  ['primeira marcação',0,false],['primeira remarcação',1,false],['remarcação da remarcação',2,false],
  ['cancelamento da primeira reserva',0,true],['cancelamento da remarcação',1,true],['cancelamento da remarcação da remarcação',2,true],
 ] as const)('%s: agente, JEV, reserva e confirmador conservam identidade, revisão e publicação',async(_nome,n,cancelada)=>{
  const {f,atual,pedido,revision}=fontes(n,cancelada);const ctx=normalizarFontesDoAtendimento(f,org);
  expect(ctx.operacoes.some(x=>x.id===atual.id)).toBe(true);
  expect(ctx.operacoes.some(x=>x.id.startsWith('antiga-'))).toBe(true);
  expect(ctx.cobertura.find(c=>c.categoria==='operacoes')).toMatchObject({estado:'excluded_by_limit',encontrados:5});
  expect(JSON.stringify(ctx.operacoes).length).toBeLessThan(4000);
  const observacao=criarObservacaoDaAgenda();
  const acao=cancelada?'cancelar':n?'remarcar':'criar';
  if(n&&!cancelada)observacao.concluir(observacao.iniciar(),'crm_reschedule_appointment',{remarcado:true,
   origem_remarcacao:{reserva_id:atual.id,inicio:['2026-11-23T13:00:00Z','2026-11-23T17:40:00Z'][n-1],fim:'2026-11-23T18:20:00Z',fuso:atual.time_zone,estado:'confirmed',revisao:revision-1},
   compromisso:{id:atual.id,starts_at:atual.starts_at,ends_at:atual.ends_at,time_zone:atual.time_zone,status:atual.status,revision}});
  const args={candidate:cancelada?'Sua reserva foi cancelada.':'Sua reserva está confirmada para o horário solicitado.',serviceContext:ctx,
   agendaOperationReceipt:n&&!cancelada?observacao.atual():{acao,reservaId:atual.id,revisao:revision} as const};
  mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}'}})
   .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}}).mockResolvedValueOnce({result:{text:'{"prometeuRetornoHumano":false,"retornoSoDoAssistente":false}'}});
  await classifyPromise(pool,{}, {tenantId:org},args,{log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never});
  expect(mock.call).toHaveBeenCalledTimes(3);
  for(const call of mock.call.mock.calls){
   const packet=JSON.parse(call[2].messages[0].content);expect(packet).toEqual(pacoteParaJev(args));
   expect(packet.contexto_atendimento.pedido_canonico.mensagem.texto).toBe(pedido);
   expect(packet.contexto_atendimento.operacoes).toEqual((pacoteFactualDaRevisao({candidate:'',serviceContext:ctx}).contexto_atendimento as {operacoes:unknown[]}).operacoes);
   expect(packet.resultado_agenda_do_turno).toMatchObject({acao_observada:acao,revisao_relida:revision,recibo:{estado:atual.status,publicacao_google:atual.google_publication,revisao_reserva:revision}});
   if(n&&!cancelada)expect(packet.resultado_agenda_do_turno.transicao_remarcacao).toMatchObject({mesma_reserva:true,origem:{revisao:revision-1},destino:{revisao:revision}});
   expect(JSON.stringify(packet)).not.toContain('privada');
  }
 });
 it('consulta sem escrita recebe a reserva ativa apesar de cancelamentos tocados depois, sem inventar transição',()=>{
  const {f,atual}=fontes(2,false),ctx=normalizarFontesDoAtendimento(f,org);const p=pacoteParaJev({candidate:'Conferi sua reserva atual.',serviceContext:ctx});
  expect(ctx.operacoes[0]?.id).toBe(atual.id);expect(p.resultado_agenda_do_turno).toBeUndefined();expect(p.fase_agenda).toBeUndefined();
 });
 it.each(['pending','stale','human'] as const)('contexto negativo %s não fabrica publicação ou aprovação humana',kind=>{
  const {f,atual}=fontes(2,false);
  if(kind==='pending'){atual.google_publication='pending';atual.needs_google_push=true;atual.google_synced_local_revision=1;}
  if(kind==='human')atual.service_requires_confirmation=true;
  const ctx=normalizarFontesDoAtendimento(f,org),a={candidate:'Está confirmada.',serviceContext:ctx,agendaOperationReceipt:{acao:'remarcar' as const,reservaId:atual.id,revisao:kind==='stale'?2:3}};
  const p=pacoteFactualDaRevisao(a),fonte=ctx.operacoes.find(x=>x.id===atual.id);expect(fonte).toBeDefined();
  expect(fonte!.dados.natureza_confirmacao).toBe(kind==='pending'?'reserva_salva_sem_publicacao_comprovada':kind==='human'?'confirmacao_humana_exigida_sem_atestado':'reserva_publicada_sem_aprovacao_humana_exigida');
  if(kind==='stale')expect(p.resultado_agenda_do_turno).toBeUndefined();
  expect(ctx.decisoes).toHaveLength(0);
 });
});


describe('contexto da retomada: publicação atual recebida pelo revisor e confirmador',()=>{
 const contexto=(revision:number):ContextoDoAtendimento=>({...serviceContext,operacoes:[{...serviceContext.operacoes[0]!,id:'publicada-privada',dados:{estado:'confirmed',revisao_reserva:revision,inicio:'2026-11-23T23:40:00Z',fim:'2026-11-24T00:20:00Z',fuso:'America/Sao_Paulo',natureza_confirmacao:'reserva_publicada_sem_aprovacao_humana_exigida',publicacao_google:'synced',revisao_google_local:revision,revisao_google_publicada:revision,publicacao_pendente:false,motivo_publicacao:null,classificacao_falha:null}}]});
 const args=(revision:number)=>({candidate:'Sua reserva está confirmada para segunda-feira às 20h40.',serviceContext:contexto(revision),humanDecisionContext:{versao:1 as const,fingerprint:'decisoes-vazias',limited:false,currentRequest:{id:'privado',text:serviceContext.pedido!.mensagem!.text,at:serviceContext.pedido!.mensagem!.at},decisions:[]},agendaOperationReceipt:criarObservacaoDaAgenda({reservaId:'publicada-privada',revisao:revision}).atual()});
 function configurar(revision:number,proof:unknown={referencia_recibo:'fonte_1',revisao_relida:revision,acao_observada:'publicar'},human=false){
  mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"afirmouConclusaoHumana":true,"repasseConcluidoFiel":true,"prometeuRetornoHumano":false,"retornoSoDoAssistente":false}'}})
   .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({afirmouConclusaoHumana:human,repasseConcluidoFiel:false,prometeuRetornoHumano:false,retornoSoDoAssistente:false,conclusaoOperacionalDaAgenda:proof})}});
 }
 it.each([1,2,3])('publicação após criação/uma/duas remarcações: revisão %s conserva prova e sinais independentes',async revision=>{
  const a=args(revision);configurar(revision);
  const v=await classifyPromise(pool,{}, {tenantId:'org'},a,{log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never});
  expect(v).toMatchObject({agendaCompativel:true,afirmouConclusaoHumana:false,repasseConcluidoFiel:false});expect(mock.call).toHaveBeenCalledTimes(3);
  for(const call of mock.call.mock.calls){const packet=JSON.parse(call[2].messages[0].content);expect(packet).toEqual(pacoteParaJev(a));
   expect(packet).toMatchObject({fase_agenda:'depois_da_escrita',proveniencia_contexto:{resultado_atual:{escopo:'retomada_nativa_da_publicacao_mesma_reserva_revisao'}},resultado_agenda_do_turno:{acao_observada:'publicar',revisao_relida:revision}});
   expect(packet.resultado_agenda_do_turno.transicao_remarcacao).toBeUndefined();expect(JSON.stringify(packet)).not.toContain('publicada-privada');}
 });
 it.each(['wrong_reference','wrong_revision','pending','human_required','human_attribution','missing'] as const)('contexto negativo %s não substitui conclusão humana por resultado automático',async kind=>{
  const a=args(3);const proof=kind==='missing'?null:{referencia_recibo:kind==='wrong_reference'?'fonte_2':'fonte_1',revisao_relida:kind==='wrong_revision'?2:3,acao_observada:'publicar'};
  if(kind==='pending')a.serviceContext.operacoes[0]!.dados.publicacao_google='pending';
  if(kind==='human_required')a.serviceContext.operacoes[0]!.dados.natureza_confirmacao='confirmacao_humana_exigida_sem_atestado';
  configurar(3,proof,kind==='human_attribution');
  const v=await classifyPromise(pool,{}, {tenantId:'org'},a,{log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never});
  if(kind==='pending') {
   expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:'contexto_incompleto'});
   expect(mock.call).not.toHaveBeenCalled();
   expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:'agenda_review_context_incomplete'});
  } else expect(v.afirmouConclusaoHumana).toBe(true);
 });
});


describe('cancelamento específico com cobertura parcial não vira ausência global',()=>{
 const ctx:ContextoDoAtendimento={...serviceContext,
  pedido:{...serviceContext.pedido!,mensagem:{...serviceContext.pedido!.mensagem!,text:'Cancele minha consulta de23/11 às14h40. Não quero reservar outro horário.'}},
  cobertura:[{categoria:'operacoes',estado:'excluded_by_limit',encontrados:5,selecionados:2,omitidos:3}],
  operacoes:[{...serviceContext.operacoes[0]!,id:'atual',dados:{estado:'cancelled',revisao_reserva:4,inicio_local:'2026-11-23T14:40:00-03:00',natureza_cancelamento:'cancelamento_sincronizado_no_google',publicacao_google:'removed',revisao_google_local:4,revisao_google_publicada:4,publicacao_pendente:false}},
   {...serviceContext.operacoes[0]!,id:'antiga',dados:{estado:'cancelled',revisao_reserva:3,inicio_local:'2026-11-23T10:00:00-03:00'}}]};
 const args={candidate:'Sua consulta de23/11 às14h40 foi cancelada.',serviceContext:ctx,humanDecisionContext:{versao:1 as const,fingerprint:'sem-decisao',limited:false,decisions:[],currentRequest:{id:'pedido',text:ctx.pedido!.mensagem!.text,at:'2026-11-23T12:00:00Z'}},agendaOperationReceipt:{acao:'cancelar' as const,reservaId:'atual',revisao:4}};
 it('mantém prova específica e cobertura idênticas no pacote para JEV, reserva e confirmador',async()=>{
  mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"afirmouConclusaoHumana":true,"repasseConcluidoFiel":true}'}})
   .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({afirmouConclusaoHumana:false,repasseConcluidoFiel:false,prometeuRetornoHumano:false,retornoSoDoAssistente:false,conclusaoOperacionalDaAgenda:{referencia_recibo:'fonte_1',revisao_relida:4,acao_observada:'cancelar'}})}});
  const v=await classifyPromise(pool,{}, {tenantId:'org'},args,{log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never});
  expect(v).toMatchObject({agendaCompativel:true,afirmouConclusaoHumana:false,repasseConcluidoFiel:false});
  const packet=pacoteParaJev(args);expect(packet.resultado_agenda_do_turno).toMatchObject({alcance:'somente_reserva_e_revisao_relidas_nao_inventario_da_agenda'});
  expect((packet.contexto_atendimento as {cobertura:unknown[]}).cobertura).toEqual(ctx.cobertura);
  expect(mock.call).toHaveBeenCalledTimes(3);
  for(const call of mock.call.mock.calls){expect(JSON.parse(call[2].messages[0].content)).toEqual(packet);expect(call[2].system).toContain('não um inventário de toda a agenda');}
 });
 it('um negativo com motivo literal não é convertido em autorização pelo recibo correto',async()=>{
  mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"afirmouConclusaoHumana":false}'}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({agendaCompativel:false,motivo_curto:'A lista é parcial.',afirmacao_sem_suporte:'Não há outro horário reservado.'})}});
  const v=await classifyPromise(pool,{}, {tenantId:'org'},{...args,candidate:args.candidate+' Não há outro horário reservado.'},{log});
  expect(v.agendaCompativel).toBe(false);
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:'agenda_request_mismatch'});
  expect(mock.call.mock.calls[1]![2].system).toContain('motivo_curto');
  expect(mock.call.mock.calls[1]![2].system).toContain('não comprova a ausência');
 });
});


describe('consulta factual de agenda com prova positiva própria',()=>{
 const at='2026-11-22T12:00:00Z';
 function args(revision=4,status='cancelled'){
  const dados={estado:status,revisao_reserva:revision,inicio:'2026-11-23T17:40:00Z',fim:'2026-11-23T18:20:00Z',fuso:'America/Sao_Paulo',
   revisao_google_local:revision,revisao_google_publicada:revision,publicacao_google:status==='cancelled'?'removed':'synced',publicacao_pendente:false,motivo_publicacao:null,classificacao_falha:null,
   cancelada_em:status==='cancelled'?at:null,natureza_cancelamento:status==='cancelled'?'cancelamento_sincronizado_no_google':'nao_cancelada',
   natureza_confirmacao:status==='confirmed'?'reserva_publicada_sem_aprovacao_humana_exigida':'reserva_nao_confirmada'};
  const ctx:ContextoDoAtendimento={...serviceContext,estadoDoJob:'running',pedido:{estado:'present',tipoTurno:'inbound_turn',gatilhoEm:at,mensagem:{id:'pedido',text:'Pode conferir o estado da minha consulta de23/11 às14h40? Não faça alteração.',at,origem:'client_message'}},
   cobertura:[{categoria:'operacoes',estado:'excluded_by_limit',encontrados:5,selecionados:2,omitidos:3}],
   operacoes:[{...serviceContext.operacoes[0]!,id:'historica',dados:{estado:'cancelled',revisao_reserva:1}},
    {...serviceContext.operacoes[0]!,id:'atual',dados}]};
  return {candidate:status==='cancelled'?'Sua consulta de23/11 às14h40 consta como cancelada.':'Sua consulta de23/11 às14h40 consta como confirmada.',serviceContext:ctx,
   humanDecisionContext:{versao:1 as const,fingerprint:'sem-decisao',limited:false,decisions:[],currentRequest:{id:'pedido',text:ctx.pedido!.mensagem!.text,at}}};
 }
 const proof=(revision=4,status='cancelled')=>({referencia_recibo:'fonte_2',revisao_relida:revision,estado_relido:status});
 const deps={log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never};
 function seed(consulta:unknown=proof(),patch:Record<string,unknown>={},agenda=true){
  mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"afirmouConclusaoHumana":true,"repasseConcluidoFiel":true}'}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({agendaCompativel:agenda})}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({afirmouConclusaoHumana:false,repasseConcluidoFiel:false,prometeuRetornoHumano:false,retornoSoDoAssistente:false,conclusaoOperacionalDaAgenda:null,consultaDeEstadoDaAgenda:consulta,...patch})}});
 }
 it.each([[1,'confirmed'],[2,'confirmed'],[3,'confirmed'],[2,'cancelled'],[3,'cancelled'],[4,'cancelled']] as const)
 ('leitura após etapa revisão %s/%s recebe prova de estado, nunca de escrita',async(revision,status)=>{
  const a=args(revision,status);seed(proof(revision,status));
  const v=await classifyPromise(pool,{}, {tenantId:'org'},a,deps);
  expect(v).toMatchObject({agendaCompativel:true,afirmouConclusaoHumana:false,repasseConcluidoFiel:false});
  const p=pacoteParaJev(a);expect(p.resultado_agenda_do_turno).toBeUndefined();expect(p.fase_agenda).toBeUndefined();
  expect((p.contexto_atendimento as Record<string,unknown>).leituras_de_estado_da_agenda).toMatchObject({origem:'releitura_scoped_do_servidor',recibos:[proof(revision,status)]});
  expect(mock.call).toHaveBeenCalledTimes(3);
  for(const c of mock.call.mock.calls)expect(JSON.parse(c[2].messages[0].content)).toEqual(p);
  const {casePromiseGate}=await import('../before-send');
  expect(casePromiseGate.evaluate({body:a.candidate,semanticPromise:v,humanDecisionContextPresent:true,casesEnabled:true} as GateContext)).toEqual({pass:true});
  expect(casePromiseGate.evaluate({body:a.candidate,semanticPromise:v,humanDecisionStale:true} as GateContext)).toMatchObject({pass:false,code:'human_decision_context_changed'});
  expect(log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({event:'human_completion_current_state_reconciled'}));
 });
 it.each([null,{},'true',{...proof(),referencia_recibo:'fonte_1'},{...proof(),revisao_relida:3},{...proof(),revisao_relida:'4'},
  {...proof(),estado_relido:'confirmed'}])('false sozinho ou referência/revisão/estado errado não concilia: %j',async consulta=>{
  seed(consulta);const v=await classifyPromise(pool,{}, {tenantId:'org'},args(),deps);expect(v.afirmouConclusaoHumana).toBe(true);
 });
 it.each([{afirmouConclusaoHumana:true},{repasseConcluidoFiel:true},{prometeuRetornoHumano:true},{retornoSoDoAssistente:true},
  {conclusaoOperacionalDaAgenda:{referencia_recibo:'fonte_2',revisao_relida:4,acao_observada:'cancelar'}}])('sinal humano ou falsa operação não se torna consulta: %j',async patch=>{
  seed(proof(),patch);expect((await classifyPromise(pool,{}, {tenantId:'org'},args(),deps)).afirmouConclusaoHumana).toBe(true);
 });
 it('o negativo independente de agenda permanece obrigatório',async()=>{
  seed(proof(),{},false);const v=await classifyPromise(pool,{}, {tenantId:'org'},args(),deps);
  expect(v).toMatchObject({agendaCompativel:false,afirmouConclusaoHumana:true});
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:'agenda_request_mismatch'});
 });
 it.each(['pending','stale','human','source','job','request','case_reply','global_limit','observed_operation'])
 ('contexto negativo %s não concilia leitura',async kind=>{
  const a=args();const receipt=a.serviceContext.operacoes[1]!.dados;
  if(kind==='pending')receipt.publicacao_pendente=true;
  if(kind==='stale')receipt.revisao_google_publicada=3;
  if(kind==='human'){receipt.estado='confirmed';receipt.publicacao_google='synced';receipt.natureza_confirmacao='confirmacao_humana_exigida_sem_atestado';}
  if(kind==='source')a.serviceContext.operacoes[1]!.estado='recorded';
  if(kind==='job')a.serviceContext.estadoDoJob='done';
  if(kind==='request')a.serviceContext.pedido!.estado='unavailable';
  if(kind==='case_reply')a.serviceContext.pedido!.tipoTurno='case_reply_turn';
  seed();
  const input=kind==='observed_operation'?{...a,agendaOperationReceipt:{acao:'cancelar' as const,reservaId:'atual',revisao:4}}:
   kind==='global_limit'?{...a,commercialEvidence:[{origem:'conhecimento' as const,referencia:'fonte',titulo:'Condições',conteudo:'condição '.repeat(10000)}]}:a;
  const v=await classifyPromise(pool,{}, {tenantId:'org'},input,deps);
  if(kind==='request'||kind==='global_limit'){
   expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:'contexto_incompleto'});
   expect(mock.call).not.toHaveBeenCalled();
   expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:'agenda_review_context_incomplete'});
  } else expect(v.afirmouConclusaoHumana).toBe(true);
 });
});


describe('consulta de disponibilidade realmente observada é compartilhada com os revisores',()=>{
 function observado(){
  const o=criarObservacaoDeConsultasDaAgenda(()=>new Date('2030-11-18T05:01:00Z'));
  o.concluir(o.iniciar({event_type_slug:'sessao-coletiva',dia:'2030-11-19',limite:50}),{
   horarios:['17:00','23:00','23:40'].map(h=>({inicio:`2030-11-19T${h}:00Z`,fim:new Date(Date.parse(`2030-11-19T${h}:00Z`)+2400000).toISOString()})),
   fuso_da_regra:'America/Sao_Paulo',publicou_horarios:true,fuso_suposto:false,total_de_horarios:3,ha_mais:false,
   fontes_defasadas:[],agenda_externa_nunca_lida:false,servico:{modo:'collective_unlimited',revisao:3},
  });
  return o.atual()!;
 }
 const texto='Amanhã, 19/11, às 6h30 não está disponível. Tenho 14h, 20h ou 20h40. Qual prefere?';
 it('leva a consulta nativa na mesma fotografia para Jev, reserva comercial/agenda e confirmador',async()=>{
  const args={candidate:texto,agendaAvailability:observado(),agendaReviewRequired:true};
  mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"prometeuRetornoHumano":true,"retornoSoDoAssistente":false}'}})
   .mockResolvedValueOnce({result:{text:'{"agendaCompativel":true}'}})
   .mockResolvedValueOnce({result:{text:'{"prometeuRetornoHumano":false,"retornoSoDoAssistente":false}'}});
  const v=await classifyPromise(pool,{}, {tenantId:'org-a'},args,
   {log,loadHumanReturnBinding:vi.fn(async()=>({is_enabled:true,purpose:'human_return_confirmation'})) as never});
  expect(v.agendaCompativel).toBe(true);
  expect(mock.call).toHaveBeenCalledTimes(3);
  const expected=pacoteParaJev(args);
  for(const call of mock.call.mock.calls) expect(JSON.parse(call[2].messages[0].content)).toEqual(expected);
  expect(expected).not.toHaveProperty('resultado_agenda_do_turno');
  expect(expected).not.toHaveProperty('operacao_proposta');
  expect(expected.consultas_disponibilidade_do_turno).toMatchObject({consultas:[{consulta:{dia:'2030-11-19'},cobertura:'present',
   resultado:{horarios:[{inicio_local:'2030-11-19T14:00:00-03:00'},{inicio_local:'2030-11-19T20:00:00-03:00'},{inicio_local:'2030-11-19T20:40:00-03:00'}],ha_mais:false}}]});
  expect(mock.call.mock.calls[1]![2].system).toContain('Não exigir recibo de reserva para');
  expect(perguntasDaRevisao(false,false,true).agenda!.instrucao).toContain('consultas_disponibilidade_do_turno');
 });
 it('consulta não libera confirmação incompatível nem substitui sinal estrito ausente',async()=>{
  const args={candidate:'Sua sessão de amanhã às 6h30 está reservada e publicada no Google.',agendaAvailability:observado()};
  expect(precisaRevisarAgenda(args)).toBe(true);
  for(const response of ['{"agendaCompativel":false}','{}']) {
   mock.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"prometeuRetornoHumano":false}'}})
    .mockResolvedValueOnce({result:{text:response}});
   const v=await classifyPromise(pool,{}, {tenantId:'org-a'},args,{log});
   expect(v.agendaCompativel).toBe(false);
   expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext)).toMatchObject({pass:false,code:response==='{}'?'agenda_review_inconclusive':'agenda_request_mismatch'});
  }
 });
 it('limite global não mantém consulta sem suas demais fontes essenciais',()=>{
  const p=pacoteFactualDaRevisao({candidate:texto,agendaAvailability:observado(),
   commercialEvidence:[{origem:'conhecimento',referencia:'fonte',titulo:'Condições',conteudo:'condição '.repeat(10000)}]});
  expect(p.limite_contexto).toBe(true);
  expect(p).not.toHaveProperty('consultas_disponibilidade_do_turno');
 });
});

describe('falha técnica de contexto e vinculação não é incompatibilidade semântica',()=>{
 it('envelope real da falha de leitura não chega aos revisores como ausência de fatos',async()=>{
  const {contextoDoAtendimentoIndisponivel}=await import('../../agent/contexto-do-atendimento');
  const v=await classifyPromise(pool,{}, {tenantId:'org-a'}, {candidate:'Qual dia prefere?',
   agendaReviewRequired:true,serviceContext:contextoDoAtendimentoIndisponivel()},{log});
  expect(mock.call).not.toHaveBeenCalled();
  expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:'contexto_incompleto'});
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext))
   .toMatchObject({pass:false,code:'agenda_review_context_incomplete'});
 });
 it.each(['unavailable','excluded_by_limit'] as const)('pedido %s impede inferência com fonte sabidamente perdida',async estado=>{
  const a={candidate:'Qual dia prefere?',agendaReviewRequired:true,
   serviceContext:{...serviceContext,pedido:{...serviceContext.pedido!,estado}}};
  const v=await classifyPromise(pool,{}, {tenantId:'org-a'},a,{log});
  expect(mock.call).not.toHaveBeenCalled();
  expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:'contexto_incompleto'});
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext))
   .toMatchObject({pass:false,code:'agenda_review_context_incomplete'});
 });
 it('recibo observado não relido não é apresentado como execução comprovada',async()=>{
  const v=await classifyPromise(pool,{}, {tenantId:'org-a'}, {candidate:'Foi cancelada.',
   agendaOperationReceipt:{acao:'cancelar',reservaId:'ausente',revisao:4}},{log});
  expect(mock.call).not.toHaveBeenCalled();
  expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:'contexto_incompleto'});
 });
 it.each(['Quero às 14h40 hoje, 16/10. Pode agendar para mim.','Sua sessão está confirmada.'])
 ('frase do cliente ou tentativa anterior não se torna acusação à candidata: %s',async frase=>{
  const a={candidate:'Qual dia prefere?',agendaReviewRequired:true,serviceContext,
   pendingAgendaCommunication:{candidate:'Sua sessão está confirmada.',code:'agenda_request_mismatch'}};
  mock.call.mockResolvedValueOnce({result:{text:resposta(true)}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({agendaCompativel:false,afirmacao_sem_suporte:frase})}});
  const v=await classifyPromise(pool,{}, {tenantId:'org-a'},a,{log});
  expect(v).toMatchObject({agendaCompativel:false,agendaReviewIssue:'candidata_desvinculada'});
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext))
   .toMatchObject({pass:false,code:'agenda_review_candidate_misbound'});
 });
 it('afirmação incompatível na candidata atual conserva o veto semântico',async()=>{
  mock.call.mockResolvedValueOnce({result:{text:resposta(false)}})
   .mockResolvedValueOnce({result:{text:JSON.stringify({agendaCompativel:false,afirmacao_sem_suporte:candidate})}});
  const v=await classifyPromise(pool,{}, {tenantId:'org-a'},{candidate,serviceContext},{log});
  expect(v.agendaReviewIssue).toBeUndefined();
  expect(semanticPromiseGate.evaluate({semanticPromise:v,agendaRequestReviewRequired:true} as GateContext))
   .toMatchObject({pass:false,code:'agenda_request_mismatch'});
 });
 it('falha técnica não fica em cache; negativo semântico válido continua memoizado',async()=>{
  const {memoizarPorCandidata}=await import('./semantic');
  const classificar=vi.fn().mockResolvedValueOnce({agendaCompativel:false,agendaReviewIssue:'sinal_invalido'})
   .mockResolvedValue({agendaCompativel:false});
  const memo=memoizarPorCandidata(classificar);
  expect((await memo('Texto')).agendaReviewIssue).toBe('sinal_invalido');
  expect((await memo('Texto')).agendaReviewIssue).toBeUndefined();
  await memo('Texto');expect(classificar).toHaveBeenCalledTimes(2);
 });
});
