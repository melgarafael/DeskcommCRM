import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyPromise, parsePromiseClassification } from './semantic';
import { detectHumanCompletion } from './conclusao-humana';
import { decidirRevisao } from './decisao-do-jev';
import type { ContextoDeDecisaoHumana } from '../../agent/contexto-de-decisao-humana';
import { casePromiseGate, type GateContext } from '../before-send';

const seam = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../edge/llm/run-model-call', () => ({ runModelCall: seam.call }));
vi.mock('@/lib/ai/decisao/revisao-resposta', () => ({
  revisarRespostaComJev: async (_pool: unknown, _cfg: unknown, _ids: unknown, _args: unknown,
    reserve: () => Promise<unknown>) => reserve(),
}));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const candidate = 'A equipe confirmou a sessão de Ana em 15/10 às 10h.';
const human = (): ContextoDeDecisaoHumana => ({ versao: 1, limited: false, fingerprint: 'factual',
  currentRequest: { id: 'request', text: 'Pode confirmar a sessão de Ana em 15/10 às 10h?', at: '2026-10-10T10:00:00Z' },
  decisions: [{ eventId: 'event', caseId: 'case', jobId: 'job', action: 'resolved',
    note: 'Pode comunicar a confirmação da sessão de Ana em 15/10 às 10h.', at: '2026-10-10T11:00:00Z',
    title: 'Sessão', summary: 'Confirmação manual', blocker: 'Confirmar disponibilidade',
    requestId: 'request', request: 'Pode confirmar a sessão de Ana em 15/10 às 10h?', provenance: 'authenticated', eligible: true }],
});
const faithful = { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: false,
  retornoSoDoAssistente: false, afirmouConclusaoHumana: true, repasseConcluidoFiel: true };
const result = (value: unknown) => ({ result: { text: typeof value === 'string' ? value : JSON.stringify(value) } });
const binding = { purpose: 'human_return_confirmation' as const, provider: 'openai' as const,
  credential_id: 'fixture', model_id: 'fixture', base_url: null, is_enabled: true };
beforeEach(() => { vi.clearAllMocks(); seam.call.mockReset(); seam.call.mockResolvedValue(result(faithful)); });
async function classify(body = candidate, context = human(), load = vi.fn(async () => null as typeof binding | null)) {
  return classifyPromise({} as pg.Pool, {}, { tenantId: 'synthetic' }, { candidate: body, humanDecisionContext: context },
    { log, loadHumanReturnBinding: load });
}

describe('julgamento completo de conclusão nas rotas de revisão', () => {
  it('conclusão fiel sem confirmador explícito preserva autorização manual', async () => {
    expect(await classify()).toMatchObject({ afirmouConclusaoHumana: true, repasseConcluidoFiel: true });
    expect(seam.call).toHaveBeenCalledOnce();
  });
  it('confirmador é consultado para conclusão sem promessa futura; recebe mesmo pacote', async () => {
    const v = await classify(candidate, human(), vi.fn(async () => binding));
    expect(v.repasseConcluidoFiel).toBe(true); expect(seam.call).toHaveBeenCalledTimes(2);
    expect(seam.call.mock.calls[0]![2].messages).toEqual(seam.call.mock.calls[1]![2].messages);
  });
  it('confirmador nega escopo; futura false não apaga veto', async () => {
    seam.call.mockResolvedValueOnce(result(faithful)).mockResolvedValueOnce(result({ ...faithful, repasseConcluidoFiel: false }));
    const v = await classify(candidate, human(), vi.fn(async () => binding));
    expect(v.repasseConcluidoFiel).toBe(false);
    expect(casePromiseGate.evaluate({ body: candidate, humanDecisionContextPresent: true, humanDecisionValidated: false,
      semanticPromise: v, casesEnabled: true, hasOpenCase: true } as GateContext)).toMatchObject({ pass: false });
  });
  it.each(['erro', '{}', { prometeuRetornoHumano: false }, { ...faithful, afirmouConclusaoHumana: 'true' }])('confirmador ilegível %j não conserva liberação', async checked => {
    seam.call.mockResolvedValueOnce(result(faithful)).mockResolvedValueOnce(result(checked));
    expect((await classify(candidate, human(), vi.fn(async () => binding))).repasseConcluidoFiel).toBe(false);
  });
  it('falha do confirmador conserva conclusão em estado fechado', async () => {
    seam.call.mockResolvedValueOnce(result(faithful)).mockRejectedValueOnce(new Error('offline'));
    expect((await classify(candidate, human(), vi.fn(async () => binding))).repasseConcluidoFiel).toBe(false);
  });
  it('leitura indisponível do binding não é ausência comprovada', async () => {
    expect((await classify(candidate, human(), vi.fn(async () => { throw new Error('offline'); }))).repasseConcluidoFiel).toBe(false);
  });
  it.each([undefined, 'true', 1, null])('sinal de conclusão ausente/trocado %j não autoriza repasse', async signal => {
    seam.call.mockResolvedValue(result({ ...faithful, afirmouConclusaoHumana: signal }));
    expect((await classify()).repasseConcluidoFiel).toBe(false);
  });
  it.each(['tentativa', 'vaga', 'revogada', 'limite'] as const)('fonte %s não sustenta conclusão', async kind => {
    const context = human();
    if (kind === 'limite') context.limited = true;
    else { context.decisions[0]!.eligible = false; context.decisions[0]!.note = kind === 'tentativa' ? 'Pode tentar confirmar.' : kind === 'vaga' ? 'ok' : 'Revogada'; }
    expect((await classify(candidate, context)).repasseConcluidoFiel).toBe(false);
  });
  it('conclusão mais retorno adicional não usa a exceção, mesmo com marcação fiel incorreta', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, prometeuRetornoHumano: true }));
    const v = await classify(candidate + ' A equipe vai te ligar amanhã.');
    expect(v.repasseConcluidoFiel).toBe(false);
  });
  it('compromisso comercial adicional continua no julgamento independente', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, isPromise: true }));
    expect((await classify(candidate + ' O plano será gratuito para sempre.')).isPromise).toBe(true);
  });
  it('fala neutra com fonte humana não ganha exceção nem é vetada por fidelidade false', async () => {
    seam.call.mockResolvedValue(result({ ...faithful, afirmouConclusaoHumana: false, repasseConcluidoFiel: false }));
    const v = await classify('Quer conhecer nossa piscina?');
    expect(v.repasseConcluidoFiel).toBe(false); expect(seam.call).toHaveBeenCalledOnce();
  });
  it.each(['erro', '{'])('parse inválido %s permanece sem sinal positivo', text => {
    expect(parsePromiseClassification(text, candidate).afirmouConclusaoHumana).toBeUndefined();
  });
});

describe('degradação local sem autoridade e sem whitelist', () => {
  it.each([candidate, 'A sessão de Ana está confirmada.', 'A equipe aprovou o pedido.', 'A liberação foi concluída.'])('detecta afirmação %s', body => expect(detectHumanCompletion(body)).toBe(true));
  it.each(['Olá!', 'Quer conhecer a piscina?', 'A sessão ainda não está confirmada.', 'A equipe não confirmou o pedido.',
    'A equipe confirmou?', 'Se a equipe aprovou, podemos conversar.', 'O cliente disse que a sessão está confirmada.'])('não transforma fala neutra/citada/negada em conclusão: %s', body => expect(detectHumanCompletion(body)).toBe(false));
});

describe('JEV: conclusão independente da fidelidade e do retorno', () => {
  const signals = { comercial: { tipo: 'noul' as const, noul: 0.01 }, retorno: { tipo: 'noul' as const, noul: 0.01 },
    so_assistente: { tipo: 'noul' as const, noul: 0.01 }, repasse: { tipo: 'noul' as const, noul: 0.01 }, conclusao: { tipo: 'noul' as const, noul: 0.99 } };
  it('negativa de fidelidade conserva afirmação de conclusão', () => {
    expect(decidirRevisao(signals, true)).toMatchObject({ motivo: 'decidiu', veredito: {
      afirmouConclusaoHumana: true, repasseConcluidoFiel: false, prometeuRetornoHumano: false } });
  });
  it('conclusão fiel é positiva sem retorno futuro', () => {
    expect(decidirRevisao({ ...signals, repasse: { tipo: 'noul', noul: 0.99 } }, true)).toMatchObject({ motivo: 'decidiu', veredito: { repasseConcluidoFiel: true } });
  });
  it.each([0.5, NaN, undefined])('conclusão duvidosa/ausente %s chama reserva', noul => {
    const { conclusao: _, ...old } = signals;
    const values = noul === undefined ? old : { ...old, conclusao: { tipo: 'noul' as const, noul } };
    expect(decidirRevisao(values, true).motivo).not.toBe('decidiu');
  });
});
