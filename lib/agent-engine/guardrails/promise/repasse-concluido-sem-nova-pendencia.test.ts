import type * as NativeResponseReview from '@/lib/ai/decisao/revisao-resposta';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyPromise, memoizarPorCandidata } from './semantic';
import { casePromiseGate, type GateContext } from '../before-send';
import { detectHumanPromise } from '../human-promise';
import type { ContextoDeDecisaoHumana } from '../../agent/contexto-de-decisao-humana';
import { CRITERIO_REPASSE } from './contrato-contexto';

const seam = vi.hoisted(() => ({ call: vi.fn(), primary: false }));
vi.mock('../../edge/llm/run-model-call', () => ({ runModelCall: seam.call }));
vi.mock('@/lib/ai/decisao/revisao-resposta', () => ({
  revisarRespostaComJev: async (_p: unknown, _c: unknown, _i: unknown, _a: unknown, reserve: () => Promise<unknown>) =>
    seam.primary ? { isPromise: false, suspectPhrase: null, afirmouConclusaoHumana: true,
      repasseConcluidoFiel: true, prometeuRetornoHumano: false, retornoSoDoAssistente: false } : reserve(),
}));
const note = 'A equipe liberou a segunda via do manual de horários para este pedido. Apenas comunicar essa decisão; nenhum agendamento foi realizado.';
const candidate = 'A equipe liberou a segunda via do manual de horários para este pedido.\n\nNenhum agendamento foi realizado.';
const human = (): ContextoDeDecisaoHumana => ({ versao: 1, limited: false, fingerprint: 'synthetic',
  currentRequest: { id: 'request', text: 'Posso receber a segunda via do manual de horários? Consulte a equipe, por favor.', at: '2026-10-21T15:00:00Z' },
  decisions: [{ eventId: 'event', caseId: 'case', jobId: 'job', action: 'resolved', note, at: '2026-10-21T15:01:00Z',
    title: 'Manual de horários', summary: 'Consulta à equipe', blocker: 'Obter decisão', requestId: 'request',
    request: 'Posso receber a segunda via do manual de horários? Consulte a equipe, por favor.', provenance: 'authenticated', eligible: true }],
});
const faithful = { isPromise: false, suspectPhrase: null, afirmouConclusaoHumana: true,
  repasseConcluidoFiel: true, prometeuRetornoHumano: false, retornoSoDoAssistente: false };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const result = (v: unknown) => ({ result: { text: JSON.stringify(v) } });
const binding = { purpose: 'human_return_confirmation' as const, provider: 'openai' as const,
  credential_id: 'fixture', model_id: 'fixture', base_url: null, is_enabled: true };
const proof = (body = candidate) => ({ candidata_analisada: body, referencias_decisoes: ['decisao_1'], divergencia: null as unknown });
async function classify(body = candidate, context = human(), confirm = false) {
  return classifyPromise({} as pg.Pool, {}, { tenantId: 'synthetic' }, { candidate: body, humanDecisionContext: context },
    { log, loadHumanReturnBinding: async () => confirm ? binding : null });
}
const gate = (body: string, semanticPromise: Awaited<ReturnType<typeof classify>>, extra = {}) => casePromiseGate.evaluate({
  body, semanticPromise, humanDecisionContextPresent: true, humanDecisionValidated: semanticPromise.repasseConcluidoFiel === true,
  casesEnabled: true, hasOpenCase: false, ...extra,
} as GateContext);
beforeEach(() => { vi.clearAllMocks(); seam.primary = false; seam.call.mockReset(); seam.call.mockResolvedValue(result(faithful)); });

describe('reprodução do contexto do falso veto, com providers determinísticos', () => {
  it.each(['principal', 'reserva'] as const)('preserva a negativa factual da operação na rota %s', async route => {
    seam.primary = route === 'principal';
    const v = await classify();
    expect(v.repasseConcluidoFiel).toBe(true);
    expect(gate(candidate, v)).toMatchObject({ pass: true });
    if (route === 'reserva') {
      const packet = JSON.parse(seam.call.mock.calls[0]![2].messages[0].content);
      expect(packet.mensagem).toBe(candidate); expect(packet.contexto_decisoes.decisoes[0].nota).toBe(note);
      expect(seam.call).toHaveBeenCalledOnce();
    }
  });
  it.each(['Falei', 'Verifiquei', 'Conferi', 'Confirmei', 'Consultei', 'Alinhei', 'Validei', 'Chequei'])('consulta perfeita passada %s não abre outra pendência após revisão fiel', async verb => {
    const body = `${verb} com a equipe. ${candidate}`;
    // A flexão qu/que já não casa os radicais c/chec do detector original.
    // As outras seis flexões demonstram o falso positivo conservador sem contexto.
    expect(detectHumanPromise(body)).toBe(!['Verifiquei', 'Chequei'].includes(verb));
    const v = await classify(body);
    expect(v.repasseConcluidoFiel).toBe(true); expect(gate(body, v)).toMatchObject({ pass: true });
  });
  it.each(["Olá! Falei com a equipe e a segunda via do manual de horários foi liberada para você.\n\nSe precisar de algo mais ou quiser conversar sobre os serviços da Convert, estou à disposição!", "Falei com a equipe e a segunda via do manual de horários já foi liberada para você!\n\nSe precisar de mais alguma coisa ou quiser tirar alguma dúvida, estou à disposição."])('beneficiário após consulta concluída não é finalidade futura: %s', async body => {
    expect(detectHumanPromise(body)).toBe(true);
    const v = await classify(body);
    expect(v.repasseConcluidoFiel).toBe(true);
    expect(gate(body, v)).toMatchObject({ pass: true });
  });
  it.each(['Falei com a equipe para verificarmos seu pedido.', 'Falei com a equipe para você verificar seu pedido.', 'Falei com a equipe para que confirmem seu pedido.'])('finalidade ainda exige revisão de pendência: %s', async body => {
    expect((await classify(body)).repasseConcluidoFiel).toBe(false);
  });
  it.each([' Falei com a equipe e vou confirmar com o responsável amanhã.', ' Já encaminhei para a equipe.',
    ' Já registrei para análise interna.', ' A equipe vai te ligar amanhã.', ' Consultei com a equipe para verificar seu pedido.'])('não apaga compromisso adicional: %s', async extra => {
    expect((await classify(candidate + extra)).repasseConcluidoFiel).toBe(false);
  });
  it.each(['inelegivel', 'limitado', 'sem_fonte'] as const)('consulta passada não libera contexto %s', async kind => {
    const ctx = human(); if (kind === 'limitado') ctx.limited = true;
    else if (kind === 'sem_fonte') ctx.decisions = []; else ctx.decisions[0]!.eligible = false;
    const body = `Falei com a equipe. ${candidate}`;
    const v = await classify(body, ctx); expect(v.repasseConcluidoFiel).toBe(false); expect(gate(body, v)).toMatchObject({ pass: false });
  });
  it('nova promessa semântica mantém porta fechada, mesmo com positivo de fidelidade', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, prometeuRetornoHumano: true }));
    const v = await classify(); expect(v.repasseConcluidoFiel).toBe(false); expect(gate(candidate, v)).toMatchObject({ pass: false });
  });
  it('contexto alterado prevalece até sobre revisão fiel', async () => {
    expect(gate(candidate, await classify(), { humanDecisionStale: true })).toMatchObject({ pass: false, code: 'human_decision_context_changed' });
  });
});

describe('negativa de fidelidade vinculada à fonte e à candidata inteira', () => {
  it('negativa sem prova é inconclusiva e fechada, sem chamada automática adicional', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, repasseConcluidoFiel: false }));
    const v = await classify(); expect(v.humanDecisionReviewIssue).toBe('negativa_sem_prova');
    expect(gate(candidate, v)).toMatchObject({ pass: false, code: 'human_decision_review_inconclusive' });
    expect(seam.call).toHaveBeenCalledOnce();
  });
  it.each(['candidata', 'fonte', 'trecho', 'natureza'] as const)('diagnóstico %s desvinculado não vira acusação nem autorização', async kind => {
    const p = proof(); p.divergencia = { trecho: 'A equipe liberou', natureza: 'objeto' };
    if (kind === 'candidata') p.candidata_analisada = 'tentativa anterior';
    if (kind === 'fonte') p.referencias_decisoes = ['decisao_99'];
    if (kind === 'trecho') p.divergencia = { trecho: 'agendei para amanhã', natureza: 'objeto' };
    if (kind === 'natureza') p.divergencia = { trecho: 'A equipe liberou', natureza: 'inventada' };
    seam.call.mockResolvedValue(result({ ...faithful, repasseConcluidoFiel: false, verificacao_decisao: p }));
    const v = await classify(); expect(v.humanDecisionReviewIssue).toBeDefined(); expect(v.repasseConcluidoFiel).toBe(false);
  });
  it('negativa concreta continua veto semântico, inclusive com Caso já aberto', async () => {
    const body = 'A equipe liberou três vias para outra pessoa.';
    seam.call.mockResolvedValue(result({ ...faithful, repasseConcluidoFiel: false, verificacao_decisao: {
      ...proof(body), divergencia: { trecho: 'três vias para outra pessoa', natureza: 'beneficiario' },
    } }));
    const v = await classify(body); expect(v.humanDecisionReviewIssue).toBeUndefined();
    expect(gate(body, v, { hasOpenCase: true })).toMatchObject({ pass: false, code: 'human_decision_unfaithful' });
  });
  it('diagnóstico positivo válido conserva o positivo estrito', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, verificacao_decisao: proof() }));
    expect((await classify()).repasseConcluidoFiel).toBe(true);
  });
  it('a resposta real da reserva WhatsApp com nota integral conserva fonte e candidata', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, humanReturnPhrase: null, humanReturnCategory: null,
      verificacao_decisao: { candidata_analisada: candidate, referencias_decisoes: [note], divergencia: null } }));
    const v = await classify();
    expect(v.repasseConcluidoFiel).toBe(true); expect(v.humanDecisionReviewIssue).toBeUndefined();
    expect(gate(candidate, v)).toMatchObject({ pass: true }); expect(seam.call).toHaveBeenCalledOnce();
  });
  it('diagnóstico positivo com candidata trocada não libera', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, verificacao_decisao: proof('outra mensagem') }));
    expect((await classify()).repasseConcluidoFiel).toBe(false);
  });
  it('confirmador explícito julga a mesma fonte e pode resolver revisão inconclusiva', async () => {
    seam.call.mockResolvedValueOnce(result({ ...faithful, repasseConcluidoFiel: false }))
      .mockResolvedValueOnce(result({ ...faithful, verificacao_decisao: proof() }));
    const v = await classify(candidate, human(), true);
    expect(v.repasseConcluidoFiel).toBe(true); expect(v.humanDecisionReviewIssue).toBeUndefined();
    expect(seam.call).toHaveBeenCalledTimes(2);
    expect(seam.call.mock.calls[0]![2].messages).toEqual(seam.call.mock.calls[1]![2].messages);
  });
  it('não memoiza diagnóstico inconclusivo; não repete chamadas sozinho', async () => {
    const classify = vi.fn().mockResolvedValueOnce({ ...faithful, repasseConcluidoFiel: false, humanDecisionReviewIssue: 'negativa_sem_prova' })
      .mockResolvedValueOnce(faithful);
    const cached = memoizarPorCandidata(classify); await cached(candidate); expect(classify).toHaveBeenCalledOnce();
    expect((await cached(candidate)).repasseConcluidoFiel).toBe(true); expect(classify).toHaveBeenCalledTimes(2);
  });
  it('critério do JEV não recebe contrato JSON da reserva', async () => {
    const actual = await vi.importActual<typeof NativeResponseReview>('@/lib/ai/decisao/revisao-resposta');
    const questions = actual.perguntasDaRevisao(false, true);
    for (const key of ['conclusao', 'repasse', 'retorno', 'comercial'] as const) {
      expect(questions[key]!.instrucao).toContain(CRITERIO_REPASSE);
      expect(questions[key]!.instrucao).not.toContain('boolean JSON');
      expect(questions[key]!.instrucao).not.toContain('verificacao_decisao');
    }
  });
});
