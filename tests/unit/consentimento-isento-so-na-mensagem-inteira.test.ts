import { describe, expect, it } from "vitest";

import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";

/**
 * A pergunta de consentimento ("quer que eu encaminhe para a equipe?") não é
 * promessa de retorno humano (casos em tests/invariants/case-promise-detector.test.ts).
 * A isenção vale para a MENSAGEM INTEIRA: filtrada frase a frase, a pergunta some
 * e leva junto o prazo ou o retorno anunciado na frase vizinha, que a detecção
 * por palavras pegava antes da isenção existir.
 *
 * Fica em `tests/unit/` para reprovar no gate rápido (`verify`), igual a
 * `vazamento-interno-detector.test.ts`. Puro: nenhum I/O.
 */
describe("consentimento junto de prazo ou retorno anunciado continua promessa", () => {
  it.each([
    "Quer que eu passe para o gerente, que te liga hoje às 15h?",
    "Posso transferir para a equipe? Eles te retornam ainda hoje.",
    "Quer que eu encaminhe para a equipe? A equipe vai te ligar amanhã.",
    "Posso falar com o responsável e ele te dá o desconto?",
    "Posso encaminhar para o setor? O responsável retorna em 10 minutos.",
  ])("%s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });
});
