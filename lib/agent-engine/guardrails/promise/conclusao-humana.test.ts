import { describe, expect, it } from 'vitest';
import { casePromiseGate, type GateContext } from '@/lib/agent-engine/guardrails/before-send';

function context(body: string, faithful = false, proof = false, claims: boolean | undefined = true): GateContext {
  return {
    body, casesEnabled: true, hasOpenCase: false, openedCaseThisTurn: false,
    humanDecisionContextPresent: true, humanDecisionValidated: proof,
    semanticPromise: { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: false,
      retornoSoDoAssistente: false, repasseConcluidoFiel: faithful,
      ...(claims === undefined ? {} : { afirmouConclusaoHumana: claims }) },
  } as unknown as GateContext;
}

describe('conclusão humana: escopo independente da promessa futura', () => {
  it.each([
    'A equipe confirmou a sessão de Bruno em 15/10 às 10h.',
    'A sessão de Ana está confirmada em 16/10 às 10h.',
    'A equipe aprovou o plano anual de Ana.',
  ])('fidelidade negativa veta conclusão fora do escopo: %s', body => {
    expect(casePromiseGate.evaluate(context(body, false, true))).toMatchObject({ pass: false });
  });
  it('Caso aberto não é recibo de conclusão', () => {
    const ctx = context('A equipe confirmou a sessão de Bruno.'); ctx.hasOpenCase = true;
    expect(casePromiseGate.evaluate(ctx)).toMatchObject({ pass: false });
  });
  it('sinal sem fonte interna não libera conclusão', () => {
    expect(casePromiseGate.evaluate(context('A equipe confirmou a sessão de Ana.', true))).toMatchObject({ pass: false });
  });
  it('campo ausente não aprova uma conclusão reconhecível', () => {
    expect(casePromiseGate.evaluate(context('A equipe confirmou a sessão de Bruno.', false, false, undefined))).toMatchObject({ pass: false });
  });
  it('conclusão manual fiel passa sem ferramenta de agenda', () => {
    expect(casePromiseGate.evaluate(context('A equipe confirmou a sessão de Ana em 15/10 às 10h.', true, true))).toEqual({ pass: true });
  });
  it.each(['Olá, Ana! Como posso ajudar?', 'Quer conhecer nossa piscina?', 'O professor avalia o nível durante a aula.'])('fidelidade false não bloqueia fala sem conclusão: %s', body => {
    expect(casePromiseGate.evaluate(context(body, false, false, false))).toEqual({ pass: true });
  });
});
