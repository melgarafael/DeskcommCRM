/**
 * A JANELA DE MANUTENÇÃO LIDA PELO APP (#4334).
 *
 * Este arquivo é o espelho em TypeScript de `janela_normalizada` e
 * `janela_contem` (`hostgator-setup-kit/_common.sh`), e a régua aqui é a MESMA
 * daquele shell: cinco campos cron, os três últimos em `*`, valor recusado =
 * janela ABERTA. Um teste que afrouxasse isso deixaria a rota fechando (ou não
 * fechando) runs por um motivo que o `agent.sh` não reconhece.
 *
 * Tempo é construído em horário LOCAL (`new Date(ano, mês, dia, hora, min)`),
 * que é o mesmo relógio que `date +%H:%M` usa no host — e o que a varredura de
 * `primeiraOportunidade` lê. Fixar em UTC faria o teste passar em UTC e falhar
 * numa VPS em -03.
 */
import { describe, expect, it } from "vitest";

import { janelaContem, normalizarJanela, primeiraOportunidade } from "./janela-de-manutencao";

describe("normalizarJanela", () => {
  it("aceita os cinco campos do cron, com um espaço entre eles", () => {
    expect(normalizarJanela("*/5 2-5 * * *")).toBe("*/5 2-5 * * *");
    expect(normalizarJanela("  */5\t2-5  *  * *  ")).toBe("*/5 2-5 * * *");
    expect(normalizarJanela("0,30 0,12 * * *")).toBe("0,30 0,12 * * *");
  });

  it("recusa o formato de faixa de horário — que é o que a issue propunha", () => {
    // `SYSTEM_UPDATE_WINDOW="02:00-05:00"` é a forma que a issue escreveu. O
    // shell recusa (não é cron), e é essa recusa que precisa chegar ao app: se
    // aqui fosse aceita, o app fecharia runs como abandonados com base numa
    // janela que o `agent.sh` nunca abriria.
    expect(normalizarJanela("02:00-05:00")).toBeNull();
    expect(normalizarJanela("2-5")).toBeNull();
  });

  it("recusa vazio, ausente e quebra de linha", () => {
    expect(normalizarJanela("")).toBeNull();
    expect(normalizarJanela("   ")).toBeNull();
    expect(normalizarJanela(null)).toBeNull();
    expect(normalizarJanela(undefined)).toBeNull();
    expect(normalizarJanela("*/5 2-5 * *\n*")).toBeNull();
  });

  it("recusa minuto e hora fora do campo", () => {
    expect(normalizarJanela("60 2-5 * * *")).toBeNull();
    expect(normalizarJanela("*/5 24 * * *")).toBeNull();
    expect(normalizarJanela("*/5 5-2 * * *")).toBeNull();
    expect(normalizarJanela("*/0 2-5 * * *")).toBeNull();
  });

  it("recusa dia, mês ou dia-da-semana diferentes de '*'", () => {
    expect(normalizarJanela("*/5 2-5 1 * *")).toBeNull();
    expect(normalizarJanela("*/5 2-5 * 1 *")).toBeNull();
    expect(normalizarJanela("*/5 2-5 * * 1")).toBeNull();
  });

  it("recusa o que não é alfabeto de cron", () => {
    expect(normalizarJanela("*/5 2-5 * * *; rm -rf /")).toBeNull();
    expect(normalizarJanela("*/5 2-5 * * *x")).toBeNull();
    expect(normalizarJanela("1-2-3 2-5 * * *")).toBeNull();
  });
});

describe("janelaContem", () => {
  const JANELA = "*/5 2-5 * * *";

  it("cobre os minutos múltiplos de 5 das 2h às 5h59", () => {
    expect(janelaContem(JANELA, 2, 0)).toBe(true);
    expect(janelaContem(JANELA, 2, 5)).toBe(true);
    expect(janelaContem(JANELA, 5, 55)).toBe(true);
  });

  it("não cobre o minuto fora do passo nem a hora fora da faixa", () => {
    expect(janelaContem(JANELA, 2, 1)).toBe(false);
    expect(janelaContem(JANELA, 2, 7)).toBe(false);
    expect(janelaContem(JANELA, 1, 55)).toBe(false);
    expect(janelaContem(JANELA, 6, 0)).toBe(false);
    expect(janelaContem(JANELA, 10, 0)).toBe(false);
  });

  it("aceita o dia inteiro quando o valor é `* *`", () => {
    expect(janelaContem("* * * * *", 23, 59)).toBe(true);
    expect(janelaContem("* * * * *", 0, 0)).toBe(true);
  });
});

describe("primeiraOportunidade", () => {
  const JANELA = "*/5 2-5 * * *";

  it("despacho de dia: a janela só abre na madrugada seguinte", () => {
    const despacho = new Date(2026, 10, 12, 10, 0);
    const primeira = primeiraOportunidade(JANELA, despacho);
    expect(primeira?.getTime()).toBe(new Date(2026, 10, 13, 2, 0).getTime());
  });

  it("despacho dentro da janela: a próxima oportunidade é o ciclo seguinte", () => {
    expect(primeiraOportunidade(JANELA, new Date(2026, 10, 12, 2, 0))?.getTime()).toBe(
      new Date(2026, 10, 12, 2, 5).getTime(),
    );
  });

  it("o minuto da própria despacho não conta — o agente pega no ciclo seguinte", () => {
    // 01:59:59 → o primeiro minuto inteiro DEPOIS é 02:00, que já está na janela.
    expect(primeiraOportunidade(JANELA, new Date(2026, 10, 12, 1, 59, 59))?.getTime()).toBe(
      new Date(2026, 10, 12, 2, 0).getTime(),
    );
    // 02:00:00 exato: 02:00 já passou, e 02:01 não casa o passo — 02:05.
    expect(primeiraOportunidade(JANELA, new Date(2026, 10, 12, 2, 0, 0))?.getTime()).toBe(
      new Date(2026, 10, 12, 2, 5).getTime(),
    );
  });
});
