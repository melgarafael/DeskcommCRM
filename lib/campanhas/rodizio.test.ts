import { describe, expect, it } from "vitest";

import { escolherNumero, poolDaCampanha, type NumeroDisponivel } from "./rodizio";

function numero(over: Partial<NumeroDisponivel> & { sessionId: string }): NumeroDisponivel {
  return {
    // `in` e não `??`: `folgaDoDia: null` é O caso do teste de teto
    // desconhecido, e `null ?? 100` o transformava em folga generosa — o helper
    // apagava o caso e o teste passava medindo outra coisa. É a segunda vez que
    // este atalho morde neste módulo; a primeira foi com `telefone: null`.
    folgaDoDia: "folgaDoDia" in over ? (over.folgaDoDia ?? null) : 100,
    podeAgora: over.podeAgora ?? true,
    ultimoEnvio: over.ultimoEnvio ?? null,
    sessionId: over.sessionId,
  };
}

describe("rodízio de números", () => {
  it("o histórico vence a folga — quem já conversa com o A recebe do A", () => {
    // Mesmo com o B três vezes mais livre: receber de um número desconhecido
    // separa a mensagem do histórico da pessoa.
    const escolha = escolherNumero(
      [numero({ sessionId: "a", folgaDoDia: 10 }), numero({ sessionId: "b", folgaDoDia: 300 })],
      "a",
    );
    expect(escolha).toEqual({ sessionId: "a", motivo: "historico" });
  });

  it("histórico que NÃO pode enviar agora não trava a pessoa: vai pelo que pode", () => {
    const escolha = escolherNumero(
      [numero({ sessionId: "a", podeAgora: false }), numero({ sessionId: "b" })],
      "a",
    );
    expect(escolha).toEqual({ sessionId: "b", motivo: "folga" });
  });

  it("histórico fora do pool é ignorado — a campanha só fala pelos números que ela declarou", () => {
    const escolha = escolherNumero([numero({ sessionId: "b" })], "z");
    expect(escolha?.sessionId).toBe("b");
  });

  it("sem histórico, ganha quem tem mais folga no dia", () => {
    const escolha = escolherNumero(
      [
        numero({ sessionId: "a", folgaDoDia: 5 }),
        numero({ sessionId: "b", folgaDoDia: 80 }),
        numero({ sessionId: "c", folgaDoDia: 40 }),
      ],
      null,
    );
    expect(escolha).toEqual({ sessionId: "b", motivo: "folga" });
  });

  it("empate na folga: ganha quem está parado há mais tempo", () => {
    const agora = Date.now();
    const escolha = escolherNumero(
      [
        numero({ sessionId: "a", folgaDoDia: 50, ultimoEnvio: new Date(agora - 60_000) }),
        numero({ sessionId: "b", folgaDoDia: 50, ultimoEnvio: new Date(agora - 600_000) }),
      ],
      null,
    );
    expect(escolha?.sessionId).toBe("b");
  });

  it("quem nunca enviou vence o empate", () => {
    const escolha = escolherNumero(
      [
        numero({ sessionId: "a", folgaDoDia: 50, ultimoEnvio: new Date() }),
        numero({ sessionId: "b", folgaDoDia: 50, ultimoEnvio: null }),
      ],
      null,
    );
    expect(escolha?.sessionId).toBe("b");
  });

  it("teto desconhecido NÃO é teto infinito: fica atrás de quem declarou folga", () => {
    // Tratar `null` como infinito faria o número sem configuração ganhar
    // sempre — concentrando nele o volume que o rodízio existe para espalhar.
    const escolha = escolherNumero(
      [numero({ sessionId: "sem-teto", folgaDoDia: null }), numero({ sessionId: "com-teto", folgaDoDia: 3 })],
      null,
    );
    expect(escolha?.sessionId).toBe("com-teto");
  });

  it("ninguém pode agora: devolve null, que é esperar e não falhar", () => {
    const escolha = escolherNumero(
      [numero({ sessionId: "a", podeAgora: false }), numero({ sessionId: "b", podeAgora: false })],
      "a",
    );
    expect(escolha).toBeNull();
  });

  it("pool vazio não escolhe ninguém", () => {
    expect(escolherNumero([], null)).toBeNull();
  });

  it("a escolha é estável: mesma entrada, mesma saída", () => {
    const entrada = [
      numero({ sessionId: "b", folgaDoDia: 10 }),
      numero({ sessionId: "a", folgaDoDia: 10 }),
    ];
    expect(escolherNumero(entrada, null)?.sessionId).toBe("a");
    expect(escolherNumero([...entrada].reverse(), null)?.sessionId).toBe("a");
  });

  it("o pool é o principal mais os vinculados, sem repetir", () => {
    expect(poolDaCampanha("a", ["b", "a", "c"])).toEqual(["a", "b", "c"]);
    expect(poolDaCampanha("a", [])).toEqual(["a"]);
  });
});
