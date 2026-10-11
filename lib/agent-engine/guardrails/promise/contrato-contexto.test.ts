import { describe, expect, it, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import { pacoteFactualDaRevisao, temDecisaoElegivel } from './contrato-contexto';
import { classifyPromise, parsePromiseClassification } from './semantic';
import { casePromiseGate, semanticPromiseGate, type GateContext } from '../before-send';
import type { ContextoDeDecisaoHumana } from '../../agent/contexto-de-decisao-humana';
import { pacoteParaJev, revisarRespostaComJev } from '@/lib/ai/decisao/revisao-resposta';
import { lerConfigDoJev } from '@/lib/ai/decisao/config';
import { decidirRevisao } from './decisao-do-jev';
import type { decidirNoPonto } from '@/lib/ai/decisao/ponto';
const seam=vi.hoisted(()=>({ call:vi.fn() }));
vi.mock('../../edge/llm/run-model-call',()=>({ runModelCall:seam.call }));
const log={ info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() };
const contexto=():ContextoDeDecisaoHumana=>({
  versao:1,fingerprint:'private-hash',limited:false,
  currentRequest:{ id:'private-message',text:'Pode confirmar a sessão de Ana em 15/10 às 10h?',at:'2026-10-10T10:00:00Z' },
  decisions:[{ eventId:'private-event',caseId:'private-case',jobId:'private-job',action:'resolved',
    note:'Pode comunicar a confirmação da sessão de Ana em 15/10 às 10h.',at:'2026-10-10T11:00:00Z',
    title:'Confirmação',summary:'Sessão solicitada',blocker:'Equipe confirma manualmente',
    requestId:'private-message',request:'Pode confirmar a sessão de Ana em 15/10 às 10h?',
    provenance:'authenticated',eligible:true }],
});
const packageOf=(candidate='A equipe confirmou a sessão de Ana em 15/10 às 10h.')=>({ candidate,commercialEvidence:[],humanDecisionContext:contexto() });
beforeEach(()=>{ vi.clearAllMocks();seam.call.mockResolvedValue({result:{text:JSON.stringify({isPromise:false,prometeuRetornoHumano:false,retornoSoDoAssistente:false,afirmouConclusaoHumana:true,repasseConcluidoFiel:true})}}); });

describe('T03 pacote factual comum',()=>{
  it('reserva sem KB recebe a mesma projeção do JEV e do confirmador, sem IDs internos',async()=>{
    const p=packageOf();
    await classifyPromise({} as pg.Pool,{}, {tenantId:'org'},p,{log,loadHumanReturnBinding:vi.fn(async()=>({purpose:'human_return_confirmation',provider:'openai',credential_id:'id',model_id:'modelo',base_url:null,is_enabled:true}))});
    expect(seam.call).toHaveBeenCalledTimes(2);
    const reserva=JSON.parse(seam.call.mock.calls[0]![2].messages[0].content);
    const confirmador=JSON.parse(seam.call.mock.calls[1]![2].messages[0].content);
    expect(reserva).toEqual(pacoteParaJev(p));expect(confirmador).toEqual(reserva);
    expect(reserva.contexto_decisoes.decisoes[0]).toMatchObject({nota:p.humanDecisionContext.decisions[0]!.note,elegivel:true});
    expect(reserva.contexto_decisoes.pedido_atual.texto).toContain('Ana');
    expect(JSON.stringify(reserva)).not.toContain('private-');
    expect(seam.call.mock.calls.map(c=>c[2].purpose)).toEqual(['promise_semantic','human_return_confirmation']);
    expect(seam.call.mock.calls[0]![2].system).not.toContain(p.humanDecisionContext.decisions[0]!.note);
  });
  it('limite não corta condições para liberar a decisão',()=>{
    const p=packageOf();p.humanDecisionContext.limited=true;
    expect(temDecisaoElegivel(p)).toBe(false);
    const huge={...p,conversationContext:{mensagens:[{papel:'cliente' as const,texto:'x'.repeat(65000)}],resumo:null,limitado:false,momento:'2026-10-10T10:00:00Z',fuso:'UTC'}};
    const projected=pacoteFactualDaRevisao(huge);
    expect(projected.limite_contexto).toBe(true);
    expect(JSON.stringify(projected)).toContain('"elegivel":false');
    expect(temDecisaoElegivel(huge)).toBe(false);
  });
  it('falha do confirmador conserva o veredito inicial, sem nova liberação',async()=>{
    seam.call.mockResolvedValueOnce({result:{text:'{"isPromise":false,"prometeuRetornoHumano":true,"repasseConcluidoFiel":false}'}}).mockRejectedValueOnce(new Error('mock indisponível'));
    const v=await classifyPromise({} as pg.Pool,{}, {tenantId:'org'},packageOf(),{log,loadHumanReturnBinding:vi.fn(async()=>({purpose:'human_return_confirmation',provider:'openai',credential_id:'id',model_id:'modelo',base_url:null,is_enabled:true}))});
    expect(v.repasseConcluidoFiel).toBe(false);expect(v.prometeuRetornoHumano).toBe(true);
  });
});

describe('T02 prova interna e sinal positivo',()=>{
  const ctx=(body:string,positive:boolean,proof=false)=>({body,casesEnabled:true,hasOpenCase:false,openedCaseThisTurn:false,humanDecisionValidated:proof,
    semanticPromise:{isPromise:false,suspectPhrase:null,prometeuRetornoHumano:true,retornoSoDoAssistente:false,repasseConcluidoFiel:positive}} as GateContext);
  it('conclusão manual fiel passa sem agenda e sem Caso duplicado',()=>{
    expect(casePromiseGate.evaluate(ctx(packageOf().candidate,true,true))).toEqual({pass:true});
  });
  it('boolean do modelo sozinho não libera',()=>{
    expect(casePromiseGate.evaluate(ctx(packageOf().candidate,true))).toMatchObject({pass:false,code:'case_promise_without_case'});
  });
  it.each([
    'A sessão de Bruno está confirmada em 15/10 às 10h.',
    'A sessão de Ana está confirmada em 16/10 às 10h.',
    'Já gravei a reserva de Ana no sistema.',
    'A sessão está confirmada e a equipe te liga amanhã.',
    'Vou tentar confirmar a sessão de Ana.',
  ])('candidata adversa continua vetada: %s',body=>{
    // Veredito negativo controlado: prova a composição do gate, não acurácia de LLM.
    expect(casePromiseGate.evaluate(ctx(body,false,true))).toMatchObject({pass:false});
  });
  it('promessa comercial adicional continua no gate comercial',()=>{
    const c=ctx('Confirmado, e garanto gratuidade por um ano.',true,true);c.semanticPromise!.isPromise=true;
    expect(semanticPromiseGate.evaluate(c)).toMatchObject({pass:false});
  });
  it('mudança de fotografia veta mesmo com Caso aberto',()=>{
    const c=ctx(packageOf().candidate,true,true);c.hasOpenCase=true;c.humanDecisionStale=true;
    expect(casePromiseGate.evaluate(c)).toMatchObject({pass:false,code:'human_decision_context_changed'});
  });
  it.each([undefined,null,'true',1,false])('sinal positivo ausente/ilegível %s falha fechado',value=>{
    const v=parsePromiseClassification(JSON.stringify({isPromise:false,repasseConcluidoFiel:value}), 'A equipe retorna.');
    expect(v.repasseConcluidoFiel===true).toBe(false);
  });
  it('sem decisão elegível a reserva não pode criar autoridade',async()=>{
    const p=packageOf();p.humanDecisionContext.decisions[0]!.eligible=false;
    const v=await classifyPromise({} as pg.Pool,{}, {tenantId:'org'},p,{log,loadHumanReturnBinding:vi.fn(async()=>null)});
    expect(v.repasseConcluidoFiel).toBe(false);
  });
});

describe('T04 aceite e conclusão independente JEV',()=>{
  let seq=0;
  const config=(version:1|2|null)=>lerConfigDoJev({jev:{ligado:true,aceite:{em:'2026-10-10T10:00:00Z',por:'11111111-1111-4111-8111-111111111111'},contexto_revisao:version?{em:'2026-10-10T10:00:00Z',por:'11111111-1111-4111-8111-111111111111',versao:version}:null,tarefas:{revisao_resposta:{estado:'decidindo'}}}});
  const responses={ comercial:{tipo:'noul' as const,noul:0.01},retorno:{tipo:'noul' as const,noul:0.01},so_assistente:{tipo:'noul' as const,noul:0.01},repasse:{tipo:'noul' as const,noul:0.99},conclusao:{tipo:'noul' as const,noul:0.99} };
  it.each([1,null] as const)('v%s não transporta categoria ampliada',async version=>{
    const perguntar=vi.fn();const reserva=vi.fn(async()=>({isPromise:false,suspectPhrase:null,prometeuRetornoHumano:true,retornoSoDoAssistente:false,repasseConcluidoFiel:false}));
    await revisarRespostaComJev({} as pg.Pool,{}, {tenantId:`consent-${++seq}`},packageOf(),reserva,{log,lerConfig:vi.fn(async()=>config(version)),perguntar,conferirOrcamento:vi.fn()});
    expect(perguntar).not.toHaveBeenCalled();expect(reserva).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({motivo:'context_consent_version_insufficient'}));
  });
  it('v2 recebe a mesma projeção, cinco observações e uma chamada de custo',async()=>{
    const dbQuery=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[]}));
    const pool={query:dbQuery} as unknown as pg.Pool;
    const perguntar=vi.fn(async(_entrada:Parameters<typeof decidirNoPonto>[0])=>({ok:true as const,respostas:responses,modelo:'jev-1.13.0',uso:{tokensDeEntrada:12,tokensDeSaida:0},latenciaMs:1}));
    const reserva=vi.fn();const p=packageOf();
    const v=await revisarRespostaComJev(pool,{}, {tenantId:`consent-${++seq}`},p,reserva,{log,lerConfig:vi.fn(async()=>config(2)),perguntar,conferirOrcamento:vi.fn()});
    expect(v.repasseConcluidoFiel).toBe(true);expect(reserva).not.toHaveBeenCalled();
    expect(perguntar).toHaveBeenCalledOnce();expect(perguntar.mock.calls[0]?.[0]).toMatchObject({estado:pacoteFactualDaRevisao(p),versaoContextoRevisao:2});
    const values=dbQuery.mock.calls[0]?.[1] as unknown[];
    expect(JSON.parse(String(values[5]))).toHaveLength(5);
    expect(JSON.stringify(values)).not.toContain(p.candidate);
  });
  it.each([0.5,NaN,undefined])('dúvida ou ausência do sinal de fidelidade %s exige reserva',value=>{
    const r=value===undefined?{comercial:responses.comercial,retorno:responses.retorno,so_assistente:responses.so_assistente}:{...responses,repasse:{tipo:'noul' as const,noul:value}};
    expect(decidirRevisao(r,true).motivo).not.toBe('decidiu');
  });
});
