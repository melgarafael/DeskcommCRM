/**
 * Guarda do conserto de ReDoS polinomial em `parseChatId` (CodeQL
 * js/polynomial-redos, alertas #6 e #7 em lib/waha/ingest.ts:106 e :109).
 *
 * SAO DOIS TESTES COM PAPEIS DIFERENTES — nao junte nem apague um.
 *
 *  1. `nao e quadratico` e o UNICO que reprova a volta de `replace(/@.*$/, "")`.
 *     O corte do sufixo e semanticamente identico a regex; nenhum teste de
 *     comportamento a distingue: a diferenca observavel e so o tempo. Para esta
 *     classe de defeito, tempo E a correcao.
 *  2. `preserva a semantica` e o unico que reprova trocar o helper por
 *     `indexOf("@")` ou `lastIndexOf("@")` — os dois atalhos obvios, e os dois
 *     errados —, e tambem a perda dos terminadores U+2028/U+2029, cujo
 *     desaparecimento num refactor seria silencioso. Medido sobre corpus
 *     exaustivo de 37.449 strings: proposto 0 divergencias, indexOf 11.760,
 *     lastIndexOf 11.798, variante sem U+2028/U+2029 4.582.
 */
import { describe, expect, it } from "vitest";

import { parseChatId } from "@/lib/waha/ingest";

describe("parseChatId nao e ReDoS polinomial", () => {
  it("nao e quadratico: chatId gigante com muitos @ resolve em tempo linear", () => {
    // O \n e o que fazia `.*$` FALHAR e o motor reiniciar a cada `@`; sem ele a
    // regex antiga tambem era rapida, e o teste nao provaria nada. `endsWith("@lid")`
    // continua true, entao a guarda de sufixo NAO protege.
    const chatId = "@".repeat(64_000) + "\n" + "@lid";

    const t0 = performance.now();
    const r = parseChatId(chatId);
    const ms = performance.now() - t0;

    // Guarda de vacuidade: se um refactor fizer isto cair em `unknown`, o caminho
    // caro deixa de ser exercitado e o teste passaria por omissao.
    expect(r.kind).toBe("lid");

    // 1000 ms e a regua ja praticada na casa para este mesmo tipo de guarda:
    // tests/unit/telefone-alternativo-do-payload.test.ts:91 (funcao irma, no MESMO
    // arquivo, contra o MESMO alerta) e lib/followup/validate-publish.test.ts:332.
    // Reprova o revert com folga (regex medida em 2.916 ms nesta entrada) sem herdar
    // o historico de flake por tempo que o vitest.config.ts documenta.
    expect(ms).toBeLessThan(1000);
  });

  it("preserva o corte de sufixo do antigo replace(/@.*$/, '') e recusa telefone inválido", () => {
    // `.` nao casa terminador de linha e `$` (sem /m) so casa no fim da string: o `@`
    // que a regex achava e o PRIMEIRO depois do ULTIMO terminador de linha. Nao e o
    // primeiro `@` (indexOf) nem o ultimo (lastIndexOf).
    const casos: Array<[string, string, string | null]> = [
      ["5511999999999@c.us", "phone", "+5511999999999"],
      ["+5511999999999@c.us", "phone", "+5511999999999"],
      ["5511999999999@s.whatsapp.net", "phone", "+5511999999999"],
      ["250302204792918@lid", "lid", "250302204792918"],
      ["120363000000000000@g.us", "group", null],
      ["", "unknown", null],
      ["11111111111@newsletter", "unknown", null],
      // degenerados: corta no PRIMEIRO @ quando nao ha terminador de linha
      ["@lid", "lid", ""],
      ["@@@@lid", "lid", ""],
      ["a@b@c@lid", "lid", "a"],
      // #3519: o corte continua igual, mas um telefone fora da faixa já não é endereçável.
      ["5511@999@c.us", "unknown", null],
      ["++5511@c.us", "unknown", null],
      ["+@c.us", "unknown", null],
      // com terminador de linha: corta no primeiro @ DEPOIS dele.
      // indexOf devolveria "" / "a"; lastIndexOf, "@@@\n@" / "a@b\nc@".
      ["@@@\n@lid", "lid", "@@@\n"],
      ["a@b\nc@lid", "lid", "a@b\nc"],
      ["@@\r@lid", "lid", "@@\r"],
      ["abc\n@c.us", "unknown", null],
      // U+2028/U+2029 tambem sao terminadores para `.` — somem facil num refactor
      // que so lembra de \n e \r, e o sumico e silencioso.
      ["@a\u2028@lid", "lid", "@a\u2028"],
      ["@x\u2029@lid", "lid", "@x\u2029"],
    ];

    for (const [entrada, kind, valor] of casos) {
      const r = parseChatId(entrada);
      expect(r.kind, `kind de ${JSON.stringify(entrada)}`).toBe(kind);
      if (kind === "lid") expect(r.lid, `lid de ${JSON.stringify(entrada)}`).toBe(valor);
      if (kind === "phone") expect(r.phone, `phone de ${JSON.stringify(entrada)}`).toBe(valor);
    }
  });
});
