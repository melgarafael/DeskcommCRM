import { describe, expect, it } from 'vitest';

import {
  PROMISE_SEMANTIC_INSTRUCTION,
  parsePromiseClassification,
} from './semantic';

/**
 * O QUE ESTA SEGUNDA PERGUNTA CONSERTA — e por que ela não virou chamada nova.
 *
 * ═══ O DEFEITO, MEDIDO EM PRODUÇÃO (2026-09-16) ═══
 *
 * O agente enviou ao cliente: *"Vou encaminhar as informações do site imobiliário
 * para análise e te retorno com a proposta."* O cliente saiu da conversa esperando
 * um orçamento. O sistema produziu ZERO casos humanos, ZERO follow-ups, ZERO avisos
 * na Central.
 *
 * Existe uma trava para exatamente isso — o gate `casePromiseGate`, código
 * `case_promise_without_case`, do lado do `before-send.ts`. Ela disparou UMA vez. O
 * desenho é de duas camadas: 1º veto ensina, 2º veto o sistema abre um caso mínimo
 * sozinho e libera. **Houve um veto e zero casos** — a segunda formulação PASSOU, e
 * o fail-safe nunca foi alcançado.
 *
 * Causa: o detector léxico (`detectHumanPromise`, `guardrails/human-promise.ts`) exige
 * palavra de alvo humano colada ao verbo. Um objeto no meio ("as informações") já
 * quebra o padrão. Nas SETE frases medidas, CINCO vazaram — inclusive uma que escreve
 * literalmente "equipe".
 *
 * ═══ POR QUE ESTA PERGUNTA ENTRA NO MESMO CLASSIFICADOR ═══
 *
 * Poderia ser uma chamada nova de modelo só para a segunda pergunta. Não é, e a
 * restrição é dura: a segunda pergunta entra no MESMO classificador, na MESMA
 * chamada, no mesmo `purpose: 'promise_semantic'`. Zero chamada a mais, zero token
 * no prompt do agente. O custo marginal de perguntar duas coisas dentro de uma
 * chamada que já acontece é uma instrução mais longa; o custo de uma chamada nova é
 * dinheiro do dono da VPS a cada veto.
 *
 * `detectHumanPromise` NÃO MUDA. Os invariantes congelados de
 * `tests/invariants/case-promise-detector.test.ts` têm três casos afirmando `false`
 * para frases específicas, e `tests/invariants/**` é bloqueado por hook de git.
 * A camada semântica é ADIÇÃO, nunca substituição.
 *
 * ═══ O QUE ESTE ARQUIVO MEDE ═══
 *
 * `parsePromiseClassification` é PURA: recebe texto, devolve veredito, não chama
 * modelo. Os casos exercitam diretamente o degrade ASSIMÉTRICO que o parser precisa
 * preservar — `isPromise` cai para `false` (rede a menos, não invariante ferida);
 * `prometeuRetornoHumano` cai para o veredito do LÉXICO (a única coisa que há entre
 * o sistema em pane e uma promessa vazando para o cliente).
 */

/** A frase nº 3 da lista medida em 2026-09-16 — o LÉXICO PEGA esta. */
const FRASE_QUE_O_LEXICO_PEGA = 'Vou encaminhar para o responsável e te retorno.';

/** Fala inocente — o LÉXICO NÃO pega esta. */
const FRASE_INOCENTE = 'Bom dia! Como posso ajudar?';

describe('parsePromiseClassification', () => {
  it('o caminho feliz lê o campo novo', () => {
    const r = parsePromiseClassification(
      '{"isPromise": false, "suspectPhrase": null, "prometeuRetornoHumano": true}',
      FRASE_INOCENTE,
    );
    expect(r.prometeuRetornoHumano).toBe(true);
  });

  it('JSON sem o campo novo → o campo NÃO vira `undefined`', () => {
    // Um sinal de segurança que sai `undefined` é pior que um que sai errado: o gate
    // o leria como ausência (compara `=== true`) e a invariante sagrada ficaria
    // desarmada sem ninguém perceber. O parser tem de devolver BOOLEAN sempre.
    const r = parsePromiseClassification(
      '{"isPromise": false, "suspectPhrase": null}',
      FRASE_INOCENTE,
    );
    expect(typeof r.prometeuRetornoHumano).toBe('boolean');
  });

  it('saída SEM JSON nenhum degrada para o LÉXICO, e não para `false`', () => {
    // ⛔ ESTE CASO É O CORAÇÃO DA ASSIMETRIA. Com `false` no degrade, ele ficaria
    // vermelho: a frase nº 3 é justamente uma que o léxico PEGA (`Vou encaminhar
    // para o responsável`), e a promessa de retorno vazaria para o cliente no
    // exato momento em que o classificador está com defeito.
    const r = parsePromiseClassification('desculpe, não consegui', FRASE_QUE_O_LEXICO_PEGA);
    expect(r.prometeuRetornoHumano).toBe(true);
  });

  it('CONTROLE do degrade — frase que o léxico NÃO pega degrada para `false`', () => {
    // Sem este caso, o caso 3 passaria mesmo que o degrade devolvesse `true` SEMPRE.
    // O par prova que o degrade é o veredito do léxico, não um `true` cego.
    const r = parsePromiseClassification('desculpe, não consegui', FRASE_INOCENTE);
    expect(r.prometeuRetornoHumano).toBe(false);
  });

  it('JSON inválido degrada igual ao caso 3', () => {
    // Texto com chaves mas conteúdo quebrado: o `catch` do `JSON.parse` cobre junto
    // do ramo sem-JSON, e a assimetria vale nos dois pontos de degrade.
    const r = parsePromiseClassification('{isPromise: sim}', FRASE_QUE_O_LEXICO_PEGA);
    expect(r.prometeuRetornoHumano).toBe(true);
  });

  it('a instrução declara as DUAS perguntas', () => {
    // Este caso existe porque a instrução é o ÚNICO lugar onde a segunda pergunta
    // vive: se alguém a reescrever e derrubar `prometeuRetornoHumano` do texto, o
    // modelo para de responder o campo, o parser cai no degrade, e nenhuma outra
    // cerca do repositório notaria — o gate continuaria verde porque o léxico
    // cobre as duas frases que ele já cobria antes.
    expect(PROMISE_SEMANTIC_INSTRUCTION).toContain('prometeuRetornoHumano');
    expect(PROMISE_SEMANTIC_INSTRUCTION).toContain('isPromise');
  });

  it('CONTROLE — `isPromise` continua degradando para `false`', () => {
    // Guarda a assimetria pelo outro lado: `isPromise` fecha ABERTO (a camada
    // determinística F4-01 já rodou e pegou o valor estruturado), `prometeuRetornoHumano`
    // fecha FECHADO ao léxico. Se alguém `uniformizar` os dois degrades — para
    // `false` em ambos ou para o léxico em ambos —, este caso ou o 3 caem.
    const r = parsePromiseClassification('desculpe, não consegui', FRASE_QUE_O_LEXICO_PEGA);
    expect(r.isPromise).toBe(false);
  });
});
