/**
 * A ASSINATURA E A IDADE DO SINAL (issue #3768, fatia 1-bis).
 *
 * Dois contratos, um arquivo puro:
 *
 *   1. a assinatura HMAC-SHA256 sobre o corpo CRU, em falha fechada — ausente,
 *      inválida e segredo ausente têm nomes distintos, porque quem depura precisa
 *      saber qual dos três foi;
 *   2. a IDADE do sinal, que virou CARIMBO e deixou de ser porteiro. É o caso
 *      central desta fatia: a plataforma reentrega por horas, e recusar uma
 *      reentrega assinada perdia o lead de vez. O 401 ficou reservado ao que não
 *      tem conserto.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ATRASO_QUE_CONTA_SEGUNDOS,
  CABECALHO_DA_ASSINATURA_DA_META,
  assinaturaDaMetaConfere,
  idadeDoSinal,
} from "./assinatura";

const SEGREDO = "segredo-do-app-de-teste";

function assinar(corpo: string, segredo = SEGREDO): string {
  return `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;
}

describe("assinaturaDaMetaConfere", () => {
  it("assinatura boa confere", () => {
    const corpo = '{"object":"page"}';
    expect(assinaturaDaMetaConfere(corpo, assinar(corpo), SEGREDO)).toBeNull();
  });

  it("cabeçalho ausente, valor sem prefixo, HEX de tamanho errado e segredo ausente têm nomes distintos", () => {
    const corpo = '{"object":"page"}';
    expect(assinaturaDaMetaConfere(corpo, null, SEGREDO)).toBe("assinatura_ausente");
    expect(assinaturaDaMetaConfere(corpo, "", SEGREDO)).toBe("assinatura_ausente");
    // Sem o segredo não há como conferir: recusar é a única resposta honesta.
    expect(assinaturaDaMetaConfere(corpo, assinar(corpo), null)).toBe("segredo_ausente");
    expect(assinaturaDaMetaConfere(corpo, "sha256=abc", SEGREDO)).toBe("assinatura_invalida");
    expect(assinaturaDaMetaConfere(corpo, "sha1=deadbeef", SEGREDO)).toBe("assinatura_invalida");
  });

  it("corpo alterado depois da assinatura não confere — a HMAC cobre o corpo CRU", () => {
    const original = '{"object":"page","n":1}';
    expect(assinaturaDaMetaConfere('{"object":"page","n":2}', assinar(original), SEGREDO)).toBe(
      "assinatura_invalida",
    );
  });

  it("assinatura de outro segredo não confere", () => {
    const corpo = '{"object":"page"}';
    expect(assinaturaDaMetaConfere(corpo, assinar(corpo, "outro"), SEGREDO)).toBe("assinatura_invalida");
  });

  it("aceita o nome do cabeçalho em caixa alta, como o HTTP entrega", () => {
    expect(CABECALHO_DA_ASSINATURA_DA_META).toBe("x-hub-signature-256");
  });
});

describe("idadeDoSinal — carimbo, e não porteiro", () => {
  const agora = new Date("2026-11-01T12:00:00.000Z");
  const agoraEmSegundos = Math.floor(agora.getTime() / 1000);

  it("sinal do agora: idade zero, não atrasado", () => {
    expect(idadeDoSinal(agoraEmSegundos, agora)).toEqual({ segundos: 0, atrasada: false });
  });

  it("sinal um pouco atrás (fila, retry imediato) ainda não conta como atrasado", () => {
    expect(idadeDoSinal(agoraEmSegundos - 120, agora)).toEqual({ segundos: 120, atrasada: false });
  });

  it("sinal de duas horas atrás é MARCADO — e não recusado", () => {
    // O ponto da fatia: este sinal ENTRA. Recusar perdia o lead, porque a
    // plataforma reentrega por horas e a próxima tentativa levaria o mesmo 401.
    const idade = idadeDoSinal(agoraEmSegundos - 7_200, agora);
    expect(idade).toEqual({ segundos: 7_200, atrasada: true });
  });

  it("sinal datado no FUTURO também é anômalo, e é marcado", () => {
    const idade = idadeDoSinal(agoraEmSegundos + 600, agora);
    expect(idade.segundos).toBe(-600);
    expect(idade.atrasada).toBe(true);
  });

  it("sem instante no corpo: idade desconhecida NÃO é recusa", () => {
    for (const instante of [null, 0, -1, Number.NaN]) {
      expect(idadeDoSinal(instante, agora)).toEqual({ segundos: null, atrasada: false });
    }
  });

  it("o limiar do carimbo é cinco minutos, e é uma constante — não configuração por fonte", () => {
    expect(ATRASO_QUE_CONTA_SEGUNDOS).toBe(300);
    expect(idadeDoSinal(agoraEmSegundos - 300, agora).atrasada).toBe(false);
    expect(idadeDoSinal(agoraEmSegundos - 301, agora).atrasada).toBe(true);
  });
});
