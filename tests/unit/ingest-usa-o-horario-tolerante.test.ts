/**
 * OS PONTOS DE CHAMADA — a tolerância só vale onde ela é chamada.
 *
 * `lib/waha/timestamp-tolerante.test.ts` (do @vgamkt, #1130) prova a função
 * `dataDoTimestamp`: segundos, milissegundos, nanossegundos e o valor ausente.
 * Ele não alcança quem a usa — medido: voltando UM dos `sent_at` para
 * `new Date(p.timestamp * 1000).toISOString()`, aquele arquivo continua
 * `4 passed`. É a classe "o teste guarda a função, não o call site", e era
 * justamente num call site que o defeito morava: o `RangeError` derrubava o
 * webhook inteiro e a mensagem do cliente se perdia.
 *
 * Aqui a leitura é da FONTE porque o alvo é a ausência de um padrão em todo o
 * arquivo — um teste de comportamento provaria o caminho que eu escolhesse
 * chamar, e o que precisa ser garantido é que não sobrou nenhum.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const INGEST = readFileSync("lib/waha/ingest.ts", "utf8");

describe("o horário do webhook, nos pontos de chamada", () => {
  it("nenhum ponto do ingest multiplica o timestamp cru por 1000", () => {
    // O padrão que lançava `RangeError: Invalid time value` com timestamp em
    // nanossegundos. Se ele voltar em qualquer um dos três lugares, o webhook
    // volta a cair inteiro naquele caminho.
    const sobraram = INGEST.split("\n")
      .map((linha, i) => [i + 1, linha] as const)
      .filter(([, linha]) => /new Date\(\s*p\.timestamp\s*\*\s*1000\s*\)/.test(linha))
      .map(([n]) => `linha ${n}`);
    expect(sobraram, "ponto do ingest ainda calcula o horário na mão").toEqual([]);
  });

  it("os quatro lugares que gravam o horário usam `dataDoTimestamp`", () => {
    // Dois `sent_at` (mensagem de entrada e mensagem enviada pelo aparelho), o
    // `markConversation`, que carimba a conversa, e o `sentAt` da mensagem de
    // GRUPO (`ingerirMensagemDeGrupo`, que serve os dois sentidos).
    const chamadas = INGEST.match(/dataDoTimestamp\(p\.timestamp, now\)/g) ?? [];
    expect(chamadas.length, "faltou um ponto de chamada de dataDoTimestamp").toBe(4);
  });

  it("o instrumento enxerga o arquivo que diz enxergar (guarda de vacuidade)", () => {
    // Sem isto, um caminho errado ou um arquivo vazio faria os dois casos acima
    // passarem por ausência de dado.
    expect(INGEST).toContain("export function dataDoTimestamp");
    expect(INGEST.length).toBeGreaterThan(10_000);
  });
});
