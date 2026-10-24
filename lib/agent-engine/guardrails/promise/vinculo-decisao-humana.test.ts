import { describe, expect, it } from 'vitest';
import type { ContextoDeDecisaoHumana } from '../../agent/contexto-de-decisao-humana';
import { pacoteFactualDaRevisao, type PacoteFactual } from './contrato-contexto';
import { vincularRevisaoHumana } from './vinculo-decisao-humana';

const note = 'A equipe liberou a segunda via do manual de horários para este pedido. Apenas comunicar essa decisão; nenhum agendamento foi realizado.';
const candidate = 'A equipe liberou a segunda via do manual de horários para este pedido.\n\nNenhum agendamento foi realizado.';
type ContextoDeTeste = Omit<ContextoDeDecisaoHumana, 'decisions'> & { decisions: Array<ContextoDeDecisaoHumana['decisions'][number]> };
const context = (): ContextoDeTeste => ({ versao: 1, limited: false, fingerprint: 'synthetic',
  currentRequest: { id: 'request', text: 'Posso receber a segunda via do manual de horários? Consulte a equipe, por favor.', at: '2026-10-21T15:00:00Z' },
  decisions: [{ eventId: 'event', caseId: 'case', jobId: 'job', action: 'resolved', note, at: '2026-10-21T15:01:00Z',
    title: 'Manual de horários', summary: 'Consulta à equipe', blocker: 'Obter decisão', requestId: 'request',
    request: 'Posso receber a segunda via do manual de horários? Consulte a equipe, por favor.', provenance: 'authorized_internal_whatsapp', eligible: true }],
});
const positive = { isPromise: false, suspectPhrase: null, afirmouConclusaoHumana: true,
  repasseConcluidoFiel: true, prometeuRetornoHumano: false, retornoSoDoAssistente: false };
const proof = (references: unknown = ['decisao_1'], body = candidate) => ({
  candidata_analisada: body, referencias_decisoes: references, divergencia: null as unknown,
});
const check = (references: unknown, human = context()) => vincularRevisaoHumana(
  { candidate, humanDecisionContext: human }, positive, { verificacao_decisao: proof(references) });
const closed = (references: unknown, human = context()) => expect(check(references, human)).toMatchObject({
  repasseConcluidoFiel: false, humanDecisionReviewIssue: 'fonte_desvinculada' });

describe('referência de revisão ligada à projeção atual, sem conceder autoridade', () => {
  it('preserva referência canônica válida', () => {
    expect(check(['decisao_1'])).toMatchObject({ repasseConcluidoFiel: true });
  });
  it('reproduz a cópia integral da nota na resposta real da reserva WhatsApp', () => {
    const result = check([note]);
    expect(result.repasseConcluidoFiel).toBe(true);
    expect(result.humanDecisionReviewIssue).toBeUndefined();
  });
  it('admite referências distintas por ID e nota integral sem misturar as decisões', () => {
    const human = context(); human.decisions.push({ ...human.decisions[0]!, eventId: 'event-2', note: 'A equipe autorizou retirar o manual hoje.' });
    expect(check(['decisao_1', human.decisions[1]!.note], human).repasseConcluidoFiel).toBe(true);
  });
  it('usa somente equivalência Unicode canônica, como na candidata inteira', () => {
    const human = context(); human.decisions[0]!.note = 'A equipe aprovou a impressão deste manual.';
    expect(check([human.decisions[0]!.note!.normalize('NFD')], human).repasseConcluidoFiel).toBe(true);
  });
  it('negativa vinculada por nota integral continua negativa e conclusiva', () => {
    const body = 'A equipe liberou a segunda via para outra pessoa.';
    const p = proof([note], body); p.divergencia = { trecho: 'para outra pessoa', natureza: 'beneficiario' };
    const v = vincularRevisaoHumana({ candidate: body, humanDecisionContext: context() },
      { ...positive, repasseConcluidoFiel: false }, { verificacao_decisao: p });
    expect(v.repasseConcluidoFiel).toBe(false); expect(v.humanDecisionReviewIssue).toBeUndefined();
  });
  it.each([[], ['decisao_99'], [123], [''], [note.slice(0, 30)], [note + ' '],
    [note.replace('segunda via', 'SEGUNDA VIA')], [note.replace('Apenas comunicar', 'Apenas  comunicar')],
    ['A equipe liberou três vias para este pedido.'], ['Consulta à equipe']].map(references => ({ references })))('referência parcial, inventada ou tipo inválido permanece fechada: %j', ({ references }) => {
    closed(references);
  });
  it('ID e nota que apontam à mesma decisão não contam como duas fontes', () => {
    const human = context(); human.decisions.push({ ...human.decisions[0]!, note: 'Outra decisão elegível.' });
    closed(['decisao_1', note], human);
  });
  it('duas decisões com a mesma nota não permitem resolver o alias por adivinhação', () => {
    const human = context(); human.decisions.push({ ...human.decisions[0]!, eventId: 'event-2' });
    closed([note], human); expect(check(['decisao_1'], human).repasseConcluidoFiel).toBe(true);
  });
  it('a ambiguidade inclui decisão inelegível com a mesma nota', () => {
    const human = context(); human.decisions.push({ ...human.decisions[0]!, eventId: 'revoked', eligible: false });
    closed([note], human);
  });
  it('nota integral de decisão inelegível não herda autoridade de outra decisão', () => {
    const human = context(); human.decisions[0]!.eligible = false;
    human.decisions.push({ ...human.decisions[0]!, note: 'Outra decisão elegível.', eligible: true });
    closed([note], human); closed(['decisao_1'], human);
  });
  it('nota semelhante a ID não transforma referência canônica desconhecida em válida', () => {
    const human = context(); human.decisions[0]!.note = 'decisao_99';
    closed(['decisao_99'], human);
  });
  it('fonte não projetada por limite global não é recuperada do contexto bruto', () => {
    const args: PacoteFactual = { candidate, humanDecisionContext: context(), commercialEvidence: [{ titulo: 'Grande', conteudo: 'x'.repeat(65000), origem: 'conhecimento', referencia: 'synthetic' }] };
    expect(pacoteFactualDaRevisao(args).limite_contexto).toBe(true);
    // A porta de elegibilidade do chamador precisa continuar fechada; o vínculo não concede positivo.
    const v = vincularRevisaoHumana(args, { ...positive, repasseConcluidoFiel: false }, { verificacao_decisao: proof([note]) });
    expect(v.repasseConcluidoFiel).toBe(false);
  });
  it('nota equivalente não dispensa candidata inteira nem ausência de compromisso adicional', () => {
    const args = { candidate, humanDecisionContext: context() };
    expect(vincularRevisaoHumana(args, positive, { verificacao_decisao: proof([note], 'Tentativa anterior') }))
      .toMatchObject({ repasseConcluidoFiel: false, humanDecisionReviewIssue: 'candidata_desvinculada' });
    expect(vincularRevisaoHumana(args, { ...positive, prometeuRetornoHumano: true }, { verificacao_decisao: proof([note]) }))
      .toMatchObject({ repasseConcluidoFiel: false, humanDecisionReviewIssue: 'sinais_conflitantes' });
  });
});
