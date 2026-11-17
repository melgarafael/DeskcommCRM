/**
 * #4429 — a ROTAÇÃO em si, sem motor no meio.
 *
 * O teste de comportamento (`tests/unit/followup-variacoes-do-passo-4429.test.ts`)
 * prova o que SAI no `fixed_body`; este prende a régua pura que decide qual
 * redação sai, incluindo os casos que a tela pode mandar e o schema recusa (mas
 * um grafo antigo, ou um `variacoes: []` gravado à mão, ainda pode trazer).
 */
import { describe, expect, it } from "vitest";

import { enviosJaFeitos, redacaoDaVez, redacoesDoPasso } from "./variacoes-do-passo";

describe("#4429 — variações do passo de mensagem", () => {
  describe("redacoesDoPasso", () => {
    it("passo de texto único devolve só o `body` — o comportamento de hoje", () => {
      expect(redacoesDoPasso({ body: "Oi" })).toEqual(["Oi"]);
    });

    it("`body` é a PRIMEIRA redação; as variações vêm depois, na ordem", () => {
      expect(redacoesDoPasso({ body: "A", variacoes: ["B", "C"] })).toEqual(["A", "B", "C"]);
    });

    it("lista vazia ou só com espaços não vira variação", () => {
      expect(redacoesDoPasso({ body: "A", variacoes: [] })).toEqual(["A"]);
      expect(redacoesDoPasso({ body: "A", variacoes: ["   ", ""] })).toEqual(["A"]);
    });

    it("apara o espaço das pontas — o texto que sai não começa nem acaba com espaço", () => {
      expect(redacoesDoPasso({ body: "A", variacoes: ["  B  "] })).toEqual(["A", "B"]);
    });
  });

  describe("redacaoDaVez", () => {
    const REDACOES = ["primeira", "segunda", "terceira"];

    it("⭐ envios seguidos nunca repetem a redação anterior", () => {
      for (let enviados = 0; enviados < 12; enviados++) {
        expect(redacaoDaVez(REDACOES, "contato-1", enviados)).not.toBe(
          redacaoDaVez(REDACOES, "contato-1", enviados + 1),
        );
      }
    });

    it("⭐ a volta passa por TODAS as redações — é rotação, não alternância", () => {
      const vistos = new Set([0, 1, 2].map((enviados) => redacaoDaVez(REDACOES, "contato-1", enviados)));
      expect(vistos).toEqual(new Set(REDACOES));
    });

    it("o MESMO estado devolve a mesma redação — sem relógio, sem sorteio", () => {
      expect(redacaoDaVez(REDACOES, "contato-1", 4)).toBe(redacaoDaVez(REDACOES, "contato-1", 4));
    });

    it("contatos diferentes não partem todos da primeira redação", () => {
      const partidas = new Set(Array.from({ length: 24 }, (_, i) => redacaoDaVez(REDACOES, `contato-${i}`, 0)));
      expect(partidas.size).toBe(REDACOES.length);
    });

    it("uma redação só (passo de hoje) devolve sempre o `body`, com qualquer histórico", () => {
      expect(redacaoDaVez(["única"], "contato-1", 0)).toBe("única");
      expect(redacaoDaVez(["única"], "contato-1", 97)).toBe("única");
    });

    it("histórico negativo ou inválido não estoura o índice", () => {
      expect(REDACOES).toContain(redacaoDaVez(REDACOES, "contato-1", -3));
      expect(REDACOES).toContain(redacaoDaVez(REDACOES, "contato-1", Number.NaN));
    });
  });

  describe("enviosJaFeitos", () => {
    it("conta só `action_sent` — recheck, adiamento e pulo não são mensagem enviada", () => {
      const eventos = [
        { event_type: "action_sent" },
        { event_type: "turn_enqueued" },
        { event_type: "action_deferred" },
        { event_type: "turn_skipped" },
        { event_type: "action_sent" },
        { event_type: null },
      ];
      expect(enviosJaFeitos(eventos)).toBe(2);
    });

    it("inscrição sem envio nenhum conta zero", () => {
      expect(enviosJaFeitos([])).toBe(0);
    });
  });
});
