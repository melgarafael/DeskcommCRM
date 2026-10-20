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
import { criarFontesConsultadasDoTurno, normalizarFontesDoAtendimento, type FontesDoAtendimento } from '../../agent/contexto-do-atendimento';
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

describe('orçamento do perfil na devolutiva humana', () => {
  const org = '11111111-1111-4111-8111-111111111111';
  const contact = '22222222-2222-4222-8222-222222222222';
  const at = '2026-10-10T11:00:00Z';
  const row = (id: string) => ({ id, organization_id: org, contact_id: contact, created_at: at });
  function fontes(): FontesDoAtendimento {
    return {
      contato: { ...row(contact), tags: ['x'.repeat(1100)], birthdate: '2000-01-01' },
      negocios: [], atividades: [], propostas: [], agenda: [], retornos: [], caso: [],
      notas: [{ ...row('nota'), headline: 'Beneficiário', body: 'Ana solicitou confirmação manual.' }],
      auxiliares: [{ ...row('documento'), body: 'x'.repeat(6650) + '\nCONDIÇÃO COMPLETA DA ORGANIZAÇÃO' }],
      job: { ...row('job'), kind: 'case_reply_turn', canonical_message: {
        id: contexto().currentRequest!.id, text: contexto().currentRequest!.text, at, origem: 'client_message',
      } },
      conversa: { ...row('conversa'), service_revision: 1, force_human: false },
    };
  }
  it('conserva memória organizacional inteira junto do perfil individual, sem ignorar cobertura', () => {
    const serviceContext = normalizarFontesDoAtendimento(fontes(), org);
    expect(serviceContext.cobertura.find(c => c.categoria === 'perfil')).toMatchObject({ estado: 'present', omitidos: 0 });
    expect(serviceContext.perfil).toHaveLength(4);
    expect(JSON.stringify(pacoteFactualDaRevisao({ ...packageOf(), serviceContext }))).toContain('CONDIÇÃO COMPLETA DA ORGANIZAÇÃO');
    expect(temDecisaoElegivel({ ...packageOf(), serviceContext })).toBe(true);
  });
  it('fontes consultadas e confirmador recebem a mesma fotografia completa sem Caso/agenda novos', async () => {
    const base = normalizarFontesDoAtendimento(fontes(), org);
    const registry = criarFontesConsultadasDoTurno(at);
    registry.registrar('memoria_org', 'documento', String(fontes().auxiliares![0]!.body));
    registry.registrar('skill_ativa', 'skill-a', 'a'.repeat(1800) + 'RESSALVA A');
    registry.registrar('referencia_skill', 'ref-a', 'b'.repeat(1600) + 'RESSALVA B');
    registry.registrar('nota_memoria', 'nota-consultada', 'Pessoa declarada: Ana, sem verificação clínica.');
    const serviceContext = registry.aplicar(base);
    expect(serviceContext.cobertura.find(c => c.categoria === 'perfil')).toMatchObject({ estado: 'present', omitidos: 0 });
    const p = { ...packageOf(), serviceContext };
    const result = await classifyPromise({} as pg.Pool, {}, { tenantId: org }, p, {
      log, loadHumanReturnBinding: vi.fn(async () => ({ purpose: 'human_return_confirmation', provider: 'openai', credential_id: 'id', model_id: 'modelo', base_url: null, is_enabled: true })),
    });
    expect(result.repasseConcluidoFiel).toBe(true);
    const reserva = JSON.parse(seam.call.mock.calls[0]![2].messages[0].content);
    const confirmador = JSON.parse(seam.call.mock.calls[1]![2].messages[0].content);
    expect(reserva).toEqual(pacoteParaJev(p));
    expect(confirmador).toEqual(reserva);
    expect(JSON.stringify(reserva)).toContain('RESSALVA A');
    expect(JSON.stringify(reserva)).toContain('RESSALVA B');
    expect(serviceContext.operacoes).toHaveLength(0);
  });
  it('memória acima de 8k e quatro skills inteiras chegam aos três revisores, sem dispensar o teto global', async () => {
    const f = fontes();
    f.auxiliares![0]!.body = 'x'.repeat(10366) + '\nCONDIÇÃO COMPLETA DA ORGANIZAÇÃO';
    const registry = criarFontesConsultadasDoTurno(at);
    const markers = ['CONDIÇÃO A', 'CONDIÇÃO B', 'CONDIÇÃO C', 'CONDIÇÃO D'];
    [1563, 1447, 4332, 537].forEach((size, i) => {
      const marker = markers[i]!;
      registry.registrar('skill_ativa', `skill-${i}`, 'x'.repeat(size - marker.length) + marker);
    });
    const serviceContext = registry.aplicar(normalizarFontesDoAtendimento(f, org));
    expect(serviceContext.cobertura.find(c => c.categoria === 'perfil')).toMatchObject({
      estado: 'present', encontrados: 8, selecionados: 8, omitidos: 0,
    });
    // A composição legítima ultrapassa a antiga quota; não depende de cortá-la ou omitir a quarta skill.
    expect(serviceContext.perfil.filter(f => ['memoria_org', 'skill_ativa'].includes(f.origem))
      .reduce((n, f) => n + JSON.stringify(f).length, 0)).toBeGreaterThan(16000);
    const p = { ...packageOf(), serviceContext };
    expect(temDecisaoElegivel(p)).toBe(true);
    await classifyPromise({} as pg.Pool, {}, { tenantId: org }, p, {
      log, loadHumanReturnBinding: vi.fn(async () => ({ purpose: 'human_return_confirmation', provider: 'openai', credential_id: 'id', model_id: 'modelo', base_url: null, is_enabled: true })),
    });
    const reserva = JSON.parse(seam.call.mock.calls[0]![2].messages[0].content);
    const confirmador = JSON.parse(seam.call.mock.calls[1]![2].messages[0].content);
    const perguntar = vi.fn(async (_entrada: Parameters<typeof decidirNoPonto>[0]) => ({ ok: true as const,
      respostas: Object.fromEntries(['comercial', 'retorno', 'so_assistente', 'repasse', 'conclusao'].map(k => [k, { tipo: 'noul' as const, noul: ['repasse', 'conclusao'].includes(k) ? 0.99 : 0.01 }])),
      modelo: 'jev-1.13.0', uso: { tokensDeEntrada: 12, tokensDeSaida: 0 }, latenciaMs: 1,
    }));
    const config = lerConfigDoJev({ jev: { ligado: true, aceite: { em: at, por: org },
      contexto_revisao: { em: at, por: org, versao: 2 }, tarefas: { revisao_resposta: { estado: 'decidindo' } } } });
    await revisarRespostaComJev({ query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool, {},
      { tenantId: 'four-skills-consent' }, p, vi.fn(), { log, lerConfig: vi.fn(async () => config), perguntar, conferirOrcamento: vi.fn() });
    expect(perguntar).toHaveBeenCalledOnce();
    expect(perguntar.mock.calls[0]![0].estado).toEqual(reserva);
    expect(confirmador).toEqual(reserva);
    for (const marker of [...markers, 'CONDIÇÃO COMPLETA DA ORGANIZAÇÃO', 'Ana solicitou']) {
      expect(JSON.stringify(reserva)).toContain(marker);
    }
    expect(JSON.stringify(reserva)).not.toContain('private-');
    const excess = { ...p, conversationContext: { mensagens: [{ papel: 'cliente' as const, texto: 'x'.repeat(65000) }],
      resumo: null, limitado: false, momento: at, fuso: 'UTC' } };
    expect(pacoteFactualDaRevisao(excess).limite_contexto).toBe(true);
    expect(temDecisaoElegivel(excess)).toBe(false);
    expect(JSON.stringify(pacoteFactualDaRevisao(excess))).toContain('"elegivel":false');
  });
  it.each(['individual', 'organizacao', 'organizacao_total', 'nota_consultada', 'skill_consultada'] as const)(
    'item/condição omitidos em %s continuam impedindo o sinal positivo', async excesso => {
      const f = fontes();
      const registry = criarFontesConsultadasDoTurno(at);
      if (excesso === 'individual') f.contato!.tags = ['x'.repeat(8100) + 'RESTRIÇÃO INDIVIDUAL'];
      if (excesso === 'organizacao') f.auxiliares![0]!.body = 'x'.repeat(24001) + 'RESTRIÇÃO ORGANIZACIONAL';
      if (excesso === 'organizacao_total') f.auxiliares = [0, 1, 2, 3].map(i => ({ ...row(`mem-${i}`), body: 'x'.repeat(6900) + `RESSALVA ${i}` }));
      if (excesso === 'nota_consultada') registry.registrar('nota_memoria', 'nota-grande', 'x'.repeat(8100) + 'RESSALVA INDIVIDUAL');
      if (excesso === 'skill_consultada') registry.registrar('referencia_skill', 'ref-grande', 'x'.repeat(8100) + 'RESSALVA DA SKILL');
      const serviceContext = registry.aplicar(normalizarFontesDoAtendimento(f, org));
      expect(serviceContext.cobertura.find(c => c.categoria === 'perfil')!.estado).toBe('excluded_by_limit');
      const p = { ...packageOf(), serviceContext };
      expect(temDecisaoElegivel(p)).toBe(false);
      // Mesmo um double que diga true não substitui a cobertura íntegra relida pelo servidor.
      const result = await classifyPromise({} as pg.Pool, {}, { tenantId: org }, p, { log, loadHumanReturnBinding: vi.fn(async () => null) });
      expect(result.repasseConcluidoFiel).toBe(false);
    },
  );
  it('fontes organizacionais não tomam o espaço do indivíduo nem emprestam sua quota', () => {
    const f = fontes();
    f.contato!.tags = ['x'.repeat(7000)];
    f.notas = [{ ...row('nota'), body: 'x'.repeat(1200) + 'RESSALVA INDIVIDUAL' }];
    f.auxiliares = [{ ...row('documento'), body: 'Política curta, sem autorizar exceção individual.' }];
    const serviceContext = normalizarFontesDoAtendimento(f, org);
    expect(serviceContext.perfil.some(p => p.origem === 'memoria_org')).toBe(true);
    expect(serviceContext.perfil.some(p => p.origem === 'memoria_do_agente')).toBe(false);
    expect(temDecisaoElegivel({ ...packageOf(), serviceContext })).toBe(false);
  });
  it('releitura da organização vence a cópia anterior e invalida a fotografia', () => {
    const f = fontes();
    const registry = criarFontesConsultadasDoTurno(at);
    registry.registrar('memoria_org', 'documento', String(f.auxiliares![0]!.body));
    const first = registry.aplicar(normalizarFontesDoAtendimento(f, org));
    f.auxiliares![0]!.body = 'CONDIÇÃO RETIFICADA: conferir a nova data.';
    const current = registry.aplicar(normalizarFontesDoAtendimento(f, org));
    expect(current.fingerprint).not.toBe(first.fingerprint);
    expect(JSON.stringify(current.perfil)).toContain('CONDIÇÃO RETIFICADA');
    expect(JSON.stringify(current.perfil)).not.toContain('CONDIÇÃO COMPLETA');
  });
});


describe('pendência real de comunicação da agenda', () => {
  it('o pacote conserva a tentativa vetada como dado, sem inventar recibo ou autorização', () => {
    const pacote = pacoteFactualDaRevisao({candidate:'Sua sessão consta às 10h.',
      pendingAgendaCommunication:{candidate:'Confirmado às 11h.',code:'agenda_request_mismatch'}});
    expect(pacote.comunicacao_agenda_pendente).toEqual({candidata_recusada:'Confirmado às 11h.',
      motivo:'agenda_request_mismatch',cobertura:'present',significado:'tentativa_nao_enviada_nao_e_prova_nem_autorizacao'});
    expect(pacote.contexto_decisoes).toBeUndefined();
    expect(pacote.operacao_proposta).toBeUndefined();
  });
  it('não recorta uma tentativa longa como se fosse contexto completo', () => {
    const pacote = pacoteFactualDaRevisao({candidate:'Resposta',
      pendingAgendaCommunication:{candidate:'x'.repeat(8001),code:'agenda_request_mismatch'}});
    expect(pacote.comunicacao_agenda_pendente).toMatchObject({candidata_recusada:null,cobertura:'excluded_by_limit'});
  });
});


it('pendência de envio chega igual ao JEV, reserva, agenda e confirmador',async()=>{
  // Sinal de agenda válido é pré-condição para alcançar o confirmador nesta prova.
  seam.call.mockResolvedValue({result:{text:JSON.stringify({isPromise:false,prometeuRetornoHumano:false,retornoSoDoAssistente:false,afirmouConclusaoHumana:true,repasseConcluidoFiel:true,agendaCompativel:true})}});
  const p={...packageOf(),pendingAgendaCommunication:{candidate:'A sessão está reservada.',code:'agenda_request_mismatch'}};
  await classifyPromise({} as pg.Pool,{}, {tenantId:'org'},p,{log,
    loadHumanReturnBinding:vi.fn(async()=>({purpose:'human_return_confirmation',provider:'openai',credential_id:'id',model_id:'modelo',base_url:null,is_enabled:true}))});
  expect(seam.call).toHaveBeenCalledTimes(3);
  const jev=pacoteParaJev(p);
  for(const call of seam.call.mock.calls) expect(JSON.parse(call[2].messages[0].content)).toEqual(jev);
  expect(jev.comunicacao_agenda_pendente).toMatchObject({cobertura:'present',candidata_recusada:'A sessão está reservada.'});
});


describe('proveniência do resumo e da tentativa de envio',()=>{
 const history={mensagens:[{papel:'cliente' as const,texto:'Remarque a sessão para14h40.',em:'2026-11-23T10:00:00Z'}],resumo:'RESULTADO DESTE TURNO: sessão anterior às10h;aguardar formulário.',limitado:false,momento:'2026-11-23T10:01:00Z',fuso:'America/Sao_Paulo'};
 it('qualifica a síntese e o veto sem apagar seu conteúdo ou fabricar prova de execução',()=>{
  const p={candidate:'A sessão atual consta às14h40.',conversationContext:history,pendingAgendaCommunication:{candidate:'Confirmada às10h.',code:'agenda_request_mismatch'}};
  const projected=pacoteFactualDaRevisao(p);
  expect(projected.proveniencia_contexto).toEqual({resumo_conversa:{natureza:'sintese_auxiliar',estado_operacional_revalidado:false},tentativa_anterior:{natureza:'diagnostico_de_envio',comprova_falha_da_execucao:false}});
  expect(projected.contexto_conversa).toEqual(history);
  expect(projected.comunicacao_agenda_pendente).toMatchObject({candidata_recusada:'Confirmada às10h.',motivo:'agenda_request_mismatch'});
  expect(projected.resultado_agenda_do_turno).toBeUndefined();expect(projected.fase_agenda).toBeUndefined();
  expect(projected).toEqual(pacoteParaJev(p));
 });
 it('não trata diagnóstico sozinho como releitura operacional atual',()=>{
  const p=pacoteFactualDaRevisao({candidate:'Ainda não foi realizada.',pendingAgendaCommunication:{candidate:'Confirmada.',code:'agenda_request_mismatch'}});
  expect(p.proveniencia_contexto).toEqual({tentativa_anterior:{natureza:'diagnostico_de_envio',comprova_falha_da_execucao:false}});
  expect(p).not.toHaveProperty('resultado_agenda_do_turno');
 });
});
