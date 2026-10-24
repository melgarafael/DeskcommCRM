import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizarFontesDoAtendimento, projetarContextoDoAtendimento, type FontesDoAtendimento } from '../../agent/contexto-do-atendimento';
import { pacoteFactualDaRevisao } from './contrato-contexto';
import { pacoteParaJev } from '@/lib/ai/decisao/revisao-resposta';
import { classifyPromise } from './semantic';
import { casePromiseGate, semanticPromiseGate, type GateContext } from '../before-send';
import type { ContextoDeDecisaoHumana } from '../../agent/contexto-de-decisao-humana';

const seam = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../edge/llm/run-model-call', () => ({ runModelCall: seam.call }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const org = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-15T13:00:00Z';
const candidate = 'Sua sessão de avaliação está confirmada para 15/10 às 10h.';
const automatic = { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: false,
  retornoSoDoAssistente: false, afirmouConclusaoHumana: false, repasseConcluidoFiel: false };
const binding = { purpose: 'human_return_confirmation' as const, provider: 'openai' as const,
  credential_id: 'fixture', model_id: 'fixture', base_url: null, is_enabled: true };
const historical = (): ContextoDeDecisaoHumana => ({ versao: 1, fingerprint: 'old-source', limited: false,
  currentRequest: { id: 'current-request', text: 'A sessão de 15/10 às 10h já está confirmada?', at },
  decisions: [{ eventId: 'old-event', caseId: 'old-case', jobId: 'old-job', action: 'resolved',
    note: 'Somente simular confirmação de outra sessão, sem reservar.', at: '2026-10-10T13:00:00Z',
    title: 'Simulação anterior', summary: 'Outro pedido', blocker: 'Equipe confirma simulação',
    requestId: 'old-request', request: 'Simule a confirmação de 13/10 às 14h.',
    provenance: 'authenticated', eligible: true }] });
function fontes(patch: Record<string, unknown> = {}): FontesDoAtendimento {
  const row = { organization_id: org, contact_id: contact, created_at: at };
  return { contato: { ...row, id: contact }, negocios: [], notas: [], atividades: [], propostas: [], retornos: [],
    agenda: [{ ...row, id: 'appointment', title: 'Sessão de avaliação', status: 'confirmed', cancelled_at: null,
      starts_at: at, ends_at: '2026-10-15T13:40:00Z', time_zone: 'America/Sao_Paulo',
      service_booking_mode: 'collective_unlimited', service_requires_confirmation: false,
      service_human_confirmed: false, service_rule_revision: 3, current_service_revision: 3,
      google_publication: 'synced', google_local_revision: 2, google_synced_local_revision: 2,
      needs_google_push: false, google_sync_error: null, google_sync_failure_kind: null, ...patch }],
    caso: [{ ...row, id: 'child-case', status: 'awaiting_human', title: 'Outra sessão para dependente',
      summary: 'Enquadramento pendente', blocker: 'Serviço em rascunho', original_request: 'Avaliação de outro beneficiário.' }],
    job: { ...row, id: 'current-job', kind: 'inbound_turn', canonical_message: { id: 'current-request',
      text: 'A sessão de 15/10 às 10h já está confirmada?', at, origem: 'client_message' } },
    conversa: { ...row, id: 'conversation', force_human: false } };
}
const context = (patch: Record<string, unknown> = {}) => normalizarFontesDoAtendimento(fontes(patch), org);
beforeEach(() => { vi.clearAllMocks(); seam.call.mockResolvedValue({ result: { text: JSON.stringify(automatic) } }); });

describe('confirmação operacional e decisão humana são fatos distintos', () => {
  it('publicação atual sem exigência humana não fabrica aprovação de pessoa', () => {
    const c = context();
    expect(c.operacoes[0]?.dados).toMatchObject({ natureza_confirmacao: 'reserva_publicada_sem_aprovacao_humana_exigida',
      confirmacao_equipe_exigida: false, confirmacao_equipe_atestada: false, publicacao_google: 'synced' });
    expect(c.decisoes).toEqual([]);
  });
  it.each([
    { google_publication: 'pending' }, { google_publication: 'retrying' }, { google_publication: 'failed' },
    { google_publication: 'conflict' }, { google_publication: 'not_configured' },
    { google_synced_local_revision: 1 }, { google_local_revision: null }, { needs_google_push: true },
    { google_sync_error: 'aguardando' }, { google_sync_failure_kind: 'human_required' },
  ])('recibo incompleto %j não ganha publicação nem confirmação humana', patch => {
    expect(context(patch).operacoes[0]?.dados.natureza_confirmacao).toBe('reserva_salva_sem_publicacao_comprovada');
  });
  it('fluxo individual nativo com campos de serviço explicitamente nulos preserva confirmação operacional', () => {
    expect(context({ service_occurrence_id: null, service_booking_mode: null, service_requires_confirmation: null })
      .operacoes[0]?.dados.natureza_confirmacao).toBe('reserva_publicada_pelo_fluxo_individual');
    expect(context({ service_occurrence_id: undefined, service_booking_mode: null, service_requires_confirmation: null })
      .operacoes[0]?.dados.natureza_confirmacao).toBe('natureza_da_confirmacao_nao_atestada');
  });
  it('aprovação genuinamente exigida continua exigida, mesmo com Google publicado', () => {
    expect(context({ service_requires_confirmation: true }).operacoes[0]?.dados.natureza_confirmacao)
      .toBe('confirmacao_humana_exigida_sem_atestado');
    expect(context({ service_requires_confirmation: true, service_human_confirmed: true }).operacoes[0]?.dados.natureza_confirmacao)
      .toBe('confirmacao_humana_atestada_na_agenda');
  });
  it.each([null, undefined])('exigência desconhecida %s não vira dispensa', value => {
    expect(context({ service_requires_confirmation: value }).operacoes[0]?.dados.natureza_confirmacao)
      .toBe('natureza_da_confirmacao_nao_atestada');
  });
  it.each([{ status: 'cancelled' }, { status: 'pending' }, { cancelled_at: at }])('reserva invalidada %j não se confirma', patch => {
    expect(context(patch).operacoes[0]?.dados.natureza_confirmacao).toBe('reserva_nao_confirmada');
  });
  it('cancelamento sincronizado é fato próprio, nunca confirmação de reserva ativa',()=>{
    const c=context({status:'cancelled',cancelled_at:at,google_publication:'removed'});
    expect(c.operacoes[0]?.dados).toMatchObject({natureza_confirmacao:'reserva_nao_confirmada',
      natureza_cancelamento:'cancelamento_sincronizado_no_google',publicacao_google:'removed'});
    expect(c.decisoes).toEqual([]);
    const packet=pacoteFactualDaRevisao({candidate:'Sua sessão foi cancelada.',serviceContext:c});
    expect(pacoteParaJev({candidate:'Sua sessão foi cancelada.',serviceContext:c})).toEqual(packet);
    expect(JSON.stringify(packet)).toContain('cancelamento_sincronizado_no_google');
  });
  it.each([
    {remarcacoes:0,inicio:'2026-10-16T17:40:00Z',local:'14:40',revision:2},
    {remarcacoes:1,inicio:'2026-10-16T22:20:00Z',local:'19:20',revision:3},
    {remarcacoes:2,inicio:'2026-10-16T23:40:00Z',local:'20:40',revision:4},
  ])('cancelamento após $remarcacoes alterações preserva último horário e revisão',t=>{
    const f=fontes({status:'cancelled',cancelled_at:at,starts_at:t.inicio,
      ends_at:new Date(Date.parse(t.inicio)+40*60_000).toISOString(),google_publication:'removed',revision:t.revision,
      google_local_revision:t.revision,google_synced_local_revision:t.revision});
    f.job!.canonical_message={id:'cancelamento-atual',text:`Cancele a mesma sessão de16/10 às${t.local}.`,at,origem:'client_message'};
    const c=normalizarFontesDoAtendimento(f,org);
    expect(c.operacoes).toHaveLength(1);
    expect(c.operacoes[0]?.dados).toMatchObject({inicio:t.inicio,natureza_cancelamento:'cancelamento_sincronizado_no_google',
      natureza_confirmacao:'reserva_nao_confirmada',revisao_reserva:t.revision,revisao_google_publicada:t.revision});
    expect(JSON.stringify(projetarContextoDoAtendimento(c))).toContain(t.local);
  });
  it.each([{google_publication:'pending'},{google_synced_local_revision:1},{needs_google_push:true},
    {google_sync_error:'pendente'},{google_sync_failure_kind:'human_required'},{google_local_revision:null}])(
    'cancelamento com publicação incompleta %j não atesta remoção',patch=>{
      expect(context({status:'cancelled',cancelled_at:at,google_publication:'removed',...patch}).operacoes[0]?.dados)
        .toMatchObject({natureza_confirmacao:'reserva_nao_confirmada',natureza_cancelamento:'cancelamento_salvo_sem_remocao_comprovada'});
    });
  it.each([{status:'confirmed',cancelled_at:at},{status:'cancelled',cancelled_at:null}])(
    'estado inconsistente %j não fabrica cancelamento sincronizado',patch=>{
      expect(context({...patch,google_publication:'removed'}).operacoes[0]?.dados.natureza_cancelamento).toBeNull();
    });
  it('outra organização/contato não fornece recibo ao pedido atual', () => {
    expect(context({ organization_id: 'foreign' }).operacoes).toEqual([]);
    expect(context({ contact_id: 'foreign' }).operacoes).toEqual([]);
  });
  it('Caso de outro pedido conserva seu objeto e bloqueio, sem aprovar a reserva atual', () => {
    expect(context().continuidade.find(f => f.origem === 'caso_humano')?.dados).toMatchObject({
      titulo: 'Outra sessão para dependente', bloqueio: 'Serviço em rascunho', pedido_original: 'Avaliação de outro beneficiário.',
      alcance: 'pendencia_do_pedido_original_nao_aprovacao_de_outro_pedido', significado: 'resposta_do_cliente_nao_verificacao' });
  });
  it('JEV, reserva e confirmador recebem o mesmo recibo e o escopo do Caso', async () => {
    const args = { candidate, commercialEvidence: [], serviceContext: context(), humanDecisionContext: historical() };
    const packet = pacoteFactualDaRevisao(args);
    expect(pacoteParaJev(args)).toEqual(packet);
    // O sinal falso inicia uma segunda opinião aqui só para medir o transporte.
    seam.call.mockResolvedValueOnce({ result: { text: JSON.stringify({ ...automatic, prometeuRetornoHumano: true }) } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ agendaCompativel: true }) } });
    const v = await classifyPromise({} as pg.Pool, {}, { tenantId: org }, args,
      { log, loadHumanReturnBinding: vi.fn(async () => binding) });
    expect(v).toMatchObject({ afirmouConclusaoHumana: false, repasseConcluidoFiel: false });
    expect(seam.call).toHaveBeenCalledTimes(3);
    expect(seam.call.mock.calls.map(c=>c[2].purpose)).toEqual(["promise_semantic","promise_semantic","human_return_confirmation"]);
    for (const call of seam.call.mock.calls) expect(JSON.parse(call[2].messages[0].content)).toEqual(packet);
  });
  it('sinal explícito operacional permite fala fiel sem transformar histórico em aprovação humana', () => {
    const gate = { body: candidate, semanticPromise: automatic, casesEnabled: true, hasOpenCase: true,
      humanDecisionContextPresent: true, humanDecisionValidated: false } as GateContext;
    expect(casePromiseGate.evaluate(gate)).toEqual({ pass: true });
    expect(semanticPromiseGate.evaluate(gate)).toEqual({ pass: true });
  });
  it('recibo atual não desliga veto à falsa autoria humana nem promessa comercial adicional', () => {
    const gate = { body: 'A equipe aprovou a sessão e o plano grátis.', semanticPromise: { ...automatic,
      afirmouConclusaoHumana: true, isPromise: true, suspectPhrase: 'plano grátis' },
      casesEnabled: true, hasOpenCase: true, humanDecisionContextPresent: true, humanDecisionValidated: false } as GateContext;
    expect(casePromiseGate.evaluate(gate)).toMatchObject({ pass: false, code: 'human_decision_unfaithful' });
    expect(semanticPromiseGate.evaluate(gate)).toMatchObject({ pass: false, code: 'promise_semantic' });
  });
});

describe('divergência de conclusão humana após operação automática do turno', () => {
  const initial = { ...automatic, afirmouConclusaoHumana: true, repasseConcluidoFiel: true };
  function scenario(acao: 'criar' | 'remarcar' | 'cancelar' = 'cancelar', revision = 2) {
    const cancel = acao === 'cancelar';
    const f = fontes({ revision, google_local_revision: revision, google_synced_local_revision: revision,
      status: cancel ? 'cancelled' : 'confirmed', cancelled_at: cancel ? at : null,
      google_publication: cancel ? 'removed' : 'synced' });
    const verb = acao === 'criar' ? 'Agende' : acao === 'remarcar' ? 'Remarque' : 'Cancele';
    const text = `${verb} minha sessão de avaliação de 15/10 às 10h.`;
    f.job!.canonical_message = { id: 'current-request', text, at, origem: 'client_message' };
    const humanDecisionContext: ContextoDeDecisaoHumana = { ...historical(),
      currentRequest: { id: 'current-request', text, at }, decisions: [] };
    return { candidate: `${acao === 'criar' ? 'Agendei' : acao === 'remarcar' ? 'Remarquei' : 'Cancelei'} sua sessão de avaliação de 15/10 às 10h.`,
      serviceContext: normalizarFontesDoAtendimento(f, org),
      agendaOperationReceipt: { acao, reservaId: 'appointment', revisao: revision },
      humanDecisionContext,
      sentAntecedents: undefined as readonly string[] | undefined };
  }
  const proof = (args: ReturnType<typeof scenario>) => {
    const r = pacoteFactualDaRevisao(args).resultado_agenda_do_turno as Record<string, unknown>;
    return { referencia_recibo: r.referencia_recibo, revisao_relida: r.revisao_relida, acao_observada: r.acao_observada };
  };
  async function review(args: ReturnType<typeof scenario>, checked: unknown,
    agenda: boolean | null = true, load = vi.fn(async () => binding as typeof binding | null), first: Partial<typeof initial> = initial) {
    seam.call.mockReset();
    seam.call.mockResolvedValueOnce({ result: { text: JSON.stringify(first) } })
      .mockResolvedValueOnce({ result: { text: JSON.stringify({ agendaCompativel: agenda }) } });
    if (checked instanceof Error) seam.call.mockRejectedValueOnce(checked);
    else seam.call.mockResolvedValueOnce({ result: { text: typeof checked === 'string' ? checked : JSON.stringify(checked) } });
    return classifyPromise({} as pg.Pool, {}, { tenantId: org }, args, { log, loadHumanReturnBinding: load });
  }
  const gate = (body: string, semanticPromise: Awaited<ReturnType<typeof review>>) => ({
    body, semanticPromise, casesEnabled: true, hasOpenCase: false,
    humanDecisionContextPresent: true, humanDecisionValidated: false } as GateContext);

  it.each([
    ['criar', 1], ['remarcar', 2], ['remarcar', 3],
    ['cancelar', 2], ['cancelar', 3], ['cancelar', 4],
  ] as const)('%s revisão %i: segunda opinião operacional vinculada corrige o falso positivo', async (acao, revision) => {
    const args = scenario(acao, revision);
    const v = await review(args, { ...automatic, conclusaoOperacionalDaAgenda: proof(args) });
    expect(v).toMatchObject({ afirmouConclusaoHumana: false, repasseConcluidoFiel: false, agendaCompativel: true });
    expect(casePromiseGate.evaluate(gate(args.candidate, v))).toEqual({ pass: true });
    expect(seam.call).toHaveBeenCalledTimes(3);
    const packets = seam.call.mock.calls.map(c => JSON.parse(c[2].messages[0].content));
    expect(packets).toEqual([pacoteFactualDaRevisao(args), pacoteFactualDaRevisao(args), pacoteFactualDaRevisao(args)]);
    expect(log.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: 'human_completion_operational_reconciled' }));
  });
  it.each([
    undefined, null, true, {}, { referencia_recibo: 'fonte_outra', revisao_relida: 2, acao_observada: 'cancelar' },
    { referencia_recibo: 'fonte_1', revisao_relida: 1, acao_observada: 'cancelar' },
    { referencia_recibo: 'fonte_1', revisao_relida: '2', acao_observada: 'cancelar' },
    { referencia_recibo: 'fonte_1', revisao_relida: 2, acao_observada: 'criar' },
  ])('negativa sem vínculo operacional válido %j mantém a proteção inicial', async conclusaoOperacionalDaAgenda => {
    const args = scenario();
    const v = await review(args, { ...automatic, conclusaoOperacionalDaAgenda });
    expect(v.afirmouConclusaoHumana).toBe(true);
    expect(casePromiseGate.evaluate(gate(args.candidate, v))).toMatchObject({ pass: false, code: 'human_decision_unfaithful' });
  });
  it.each([new Error('offline'), 'erro', '{}', { prometeuRetornoHumano: false },
    { ...automatic, afirmouConclusaoHumana: 'false' }, { ...automatic, repasseConcluidoFiel: 'false' },
    { ...automatic, retornoSoDoAssistente: true }, { ...automatic, repasseConcluidoFiel: true },
  ])('confirmador falho/ambíguo %j não derruba a marcação', async checked => {
    const args = scenario();
    const value = typeof checked === 'object' && !(checked instanceof Error)
      ? { ...checked, conclusaoOperacionalDaAgenda: proof(args) } : checked;
    expect((await review(args, value)).afirmouConclusaoHumana).toBe(true);
  });
  it.each([null, { ...binding, is_enabled: false }])('binding ausente/desligado não assume segunda opinião', async value => {
    const args = scenario();
    const v = await review(args, automatic, true, vi.fn(async () => value));
    expect(v.afirmouConclusaoHumana).toBe(true); expect(seam.call).toHaveBeenCalledTimes(2);
  });
  it('falha ao reler binding conserva a marcação inicial', async () => {
    const args = scenario();
    expect((await review(args, automatic, true, vi.fn(async () => { throw new Error('offline'); }))).afirmouConclusaoHumana).toBe(true);
  });
  it.each([false, null])('agenda negativa/ausente %s não permite conciliar por recibo', async agenda => {
    const args = scenario();
    const v = await review(args, { ...automatic, conclusaoOperacionalDaAgenda: proof(args) }, agenda);
    expect(v.afirmouConclusaoHumana).toBe(true);
  });
  it.each(['observacao_ausente', 'outra_reserva', 'revisao_antiga', 'pedido_ausente', 'pacote_limitado',
    'remoção_pendente', 'google_antigo', 'humano_exigido'] as const)('fonte %s não concede conciliação operacional', async kind => {
    const args = scenario(kind === 'humano_exigido' ? 'criar' : 'cancelar');
    const conclusaoOperacionalDaAgenda = proof(args);
    if (kind === 'observacao_ausente') delete (args as { agendaOperationReceipt?: unknown }).agendaOperationReceipt;
    if (kind === 'outra_reserva') args.agendaOperationReceipt.reservaId = 'outra-reserva';
    if (kind === 'revisao_antiga') args.agendaOperationReceipt.revisao = 1;
    if (kind === 'pedido_ausente') args.serviceContext.pedido!.estado = 'unavailable';
    if (kind === 'pacote_limitado') args.sentAntecedents = ['x'.repeat(65000)];
    if (kind === 'remoção_pendente') args.serviceContext.operacoes[0]!.dados.natureza_cancelamento = 'cancelamento_salvo_sem_remocao_comprovada';
    if (kind === 'google_antigo') {
      args.serviceContext.operacoes[0]!.dados.revisao_google_local = 1;
      args.serviceContext.operacoes[0]!.dados.revisao_google_publicada = 1;
    }
    if (kind === 'humano_exigido') args.serviceContext.operacoes[0]!.dados.natureza_confirmacao = 'confirmacao_humana_exigida_sem_atestado';
    const v = await review(args, { ...automatic, conclusaoOperacionalDaAgenda });
    if (['outra_reserva', 'revisao_antiga', 'pedido_ausente', 'pacote_limitado'].includes(kind)) {
      // O preflight de contexto introduzido depois deste teste fecha antes dos modelos.
      // Não inventa autoria humana ou negativa semântica a partir da fonte ausente.
      expect(v).toMatchObject({ agendaCompativel: false, agendaReviewIssue: 'contexto_incompleto', retornoSoDoAssistente: false });
      expect(seam.call).not.toHaveBeenCalled();
      expect(semanticPromiseGate.evaluate({ ...gate(args.candidate, v), agendaRequestReviewRequired: true }))
        .toMatchObject({ pass: false, detail: { agenda_review: 'inconclusive', motivo: 'contexto_incompleto' } });
    } else {
      expect(v.afirmouConclusaoHumana).toBe(true);
    }
  });
  it('afirmação humana adicional não vira automática por haver um recibo', async () => {
    const args = scenario(); args.candidate += ' A equipe aprovou também sua isenção.';
    const v = await review(args, { ...automatic, afirmouConclusaoHumana: true, repasseConcluidoFiel: false,
      conclusaoOperacionalDaAgenda: null });
    expect(casePromiseGate.evaluate(gate(args.candidate, v))).toMatchObject({ pass: false, code: 'human_decision_unfaithful' });
  });
  it('negativa isolada não apaga conclusão reconhecida pelo fallback com fonte humana', async () => {
    const args = scenario('criar'); args.candidate = 'A equipe confirmou sua sessão de avaliação.';
    args.humanDecisionContext = historical(); args.humanDecisionContext.decisions[0]!.eligible = false;
    const { afirmouConclusaoHumana: _, ...missing } = initial;
    const v = await review(args, { ...automatic, conclusaoOperacionalDaAgenda: null }, true,
      vi.fn(async () => binding), missing);
    expect(v.afirmouConclusaoHumana).toBe(true);
    expect(casePromiseGate.evaluate(gate(args.candidate, v))).toMatchObject({ pass: false, code: 'human_decision_unfaithful' });
  });
  it('retorno futuro adicional conserva exigência de Caso', async () => {
    const args = scenario(); args.candidate += ' A equipe vai ligar para você.';
    const v = await review(args, { ...automatic, prometeuRetornoHumano: true, conclusaoOperacionalDaAgenda: proof(args) });
    expect(v.afirmouConclusaoHumana).toBe(true); expect(v.prometeuRetornoHumano).toBe(true);
    expect(casePromiseGate.evaluate(gate(args.candidate, v)).pass).toBe(false);
  });
  it('conciliação operacional não apaga veto comercial independente', async () => {
    const args = scenario();
    const v = await review(args, { ...automatic, conclusaoOperacionalDaAgenda: proof(args) }, true,
      vi.fn(async () => binding), { ...initial, isPromise: true });
    expect(v.afirmouConclusaoHumana).toBe(false);
    expect(v.isPromise).toBe(true);
    expect(semanticPromiseGate.evaluate(gate(args.candidate, v))).toMatchObject({ pass: false, code: 'promise_semantic' });
  });
});
