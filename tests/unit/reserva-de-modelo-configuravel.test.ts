/**
 * A RESERVA DE MODELO CONFIGURÁVEL (#4600) — a política, provada por caso.
 *
 * Antes desta fatia, a reserva só existia para o provedor por ASSINATURA: o mapa
 * `RESERVA_POR_ASSINATURA` devolvia `null` para todo o resto, então provedor
 * personalizado, OpenRouter, DeepSeek e afins não tinham degrau nenhum — cota
 * estourada (429), 5xx ou tempo esgotado derrubavam o turno e o cliente ficava
 * sem resposta até a cota voltar.
 *
 * O que este arquivo prova, e é o que a issue #4600 pede:
 *  - DESLIGADO por padrão: sem reserva configurada nada cai, e o caminho da
 *    assinatura continua respondendo exatamente como antes;
 *  - cada motivo PERMITIDO (cota, servidor, tempo esgotado) leva à reserva;
 *  - os dois PROIBIDOS (400 e 422 — erro de pedido) não caem, porque o mesmo
 *    corpo seria recusado de novo e o cliente pagaria duas chamadas por dois
 *    erros;
 *  - é UMA tentativa: a segunda pergunta devolve `null`, sem laço;
 *  - qualquer provedor cadastrado serve de reserva — a decisão não pergunta qual
 *    é o principal;
 *  - o par (provedor, modelo) chega ao seam como override, e o override nasce
 *    vazio quando a versão não configura reserva.
 */
import { describe, expect, it } from "vitest";

import {
  PROVEDOR_POR_ASSINATURA,
  classificarFalhaDaReservaDoModelo,
  decidirQuedaDoModeloDeReserva,
  decidirQuedaDoProvedor,
  estourouOTempo,
  provedorDeReserva,
  type MotivoDaQuedaDoModelo,
} from "@/lib/ai/pontos/reserva-da-assinatura";
import { overrideLlmDoAgente, type PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";

/** A reserva de um agente configurado — OpenRouter para DeepSeek, de propósito. */
const RESERVA = { provider: "deepseek", model: "deepseek-chat" };

describe("classificarFalhaDaReservaDoModelo — os três motivos permitidos", () => {
  const permitidos: [string, number | null, string | null, MotivoDaQuedaDoModelo][] = [
    ["cota estourada devolve 429", 429, null, "cota"],
    ["cota estourada com detalhe", 429, "rate limit exceeded", "cota"],
    ["500 do provedor", 500, null, "falha_do_provedor"],
    ["502 do gateway", 502, null, "falha_do_provedor"],
    ["503 do provedor", 503, null, "falha_do_provedor"],
    ["tempo esgotado sem status", null, "timeout", "tempo_esgotado"],
    ["tempo esgotado (timed out)", null, "Request timed out.", "tempo_esgotado"],
    ["tempo esgotado (ETIMEDOUT)", null, "connect ETIMEDOUT", "tempo_esgotado"],
  ];

  it.each(permitidos)("%s", (_nome, status, detalhe, esperado) => {
    expect(classificarFalhaDaReservaDoModelo({ status, detalhe })).toBe(esperado);
  });
});

describe("classificarFalhaDaReservaDoModelo — o que NÃO cai", () => {
  // Os dois que a issue nomeia: erro de pedido. O corpo recusado seria recusado
  // de novo pela reserva, gastando duas chamadas para colher dois erros.
  it("400 de payload não cai", () => {
    expect(classificarFalhaDaReservaDoModelo({ status: 400, detalhe: "invalid tool schema" })).toBeNull();
  });

  it("422 de parâmetro não cai", () => {
    expect(classificarFalhaDaReservaDoModelo({ status: 422, detalhe: "unprocessable" })).toBeNull();
  });

  it.each<[string, number]>([
    ["401 de credencial", 401],
    ["403 de acesso", 403],
    ["404 de rota/modelo", 404],
    ["402 de crédito (não está na régua desta reserva)", 402],
  ])("%s também não cai", (_nome, status) => {
    expect(classificarFalhaDaReservaDoModelo({ status })).toBeNull();
  });

  it("sem resposta e SEM sinal de tempo esgotado não cai (rede não é indisponibilidade do outro provedor)", () => {
    expect(classificarFalhaDaReservaDoModelo({ status: null, detalhe: "fetch failed" })).toBeNull();
    expect(classificarFalhaDaReservaDoModelo({ status: null })).toBeNull();
  });

  it("2xx não é falha", () => {
    expect(classificarFalhaDaReservaDoModelo({ status: 200 })).toBeNull();
  });
});

describe("estourouOTempo — o sinal do tempo esgotado", () => {
  it.each<string>(["timeout", "Timed out", "time out", "ETIMEDOUT", "Deadline Exceeded", "aborted due to timeout"])(
    "%s é tempo esgotado",
    (texto) => {
      expect(estourouOTempo(texto)).toBe(true);
    },
  );

  it.each<string>(["fetch failed", "ECONNREFUSED", "socket hang up", ""])("%s não é", (texto) => {
    expect(estourouOTempo(texto)).toBe(false);
  });
});

describe("decidirQuedaDoModeloDeReserva — desligado por padrão", () => {
  // O critério que protege quem nunca configurou nada: nenhuma reserva, nenhum
  // degrau. Mesmo com cota estourada, o desfecho é o de hoje.
  it.each<[string, { provider: string; model: string } | null | undefined]>([
    ["reserva ausente", undefined],
    ["reserva nula", null],
  ])("%s ⇒ null (nada cai)", (_nome, reserva) => {
    expect(
      decidirQuedaDoModeloDeReserva({ reserva, status: 429, jaCaiuParaAReserva: false }),
    ).toBeNull();
  });

  it("par pela metade (provedor sem modelo) não vira degrau", () => {
    expect(
      decidirQuedaDoModeloDeReserva({
        reserva: { provider: "deepseek", model: "   " },
        status: 429,
        jaCaiuParaAReserva: false,
      }),
    ).toBeNull();
    expect(
      decidirQuedaDoModeloDeReserva({
        reserva: { provider: "", model: "deepseek-chat" },
        status: 500,
        jaCaiuParaAReserva: false,
      }),
    ).toBeNull();
  });
});

describe("decidirQuedaDoModeloDeReserva — cada motivo permitido cai para a reserva", () => {
  it.each<[string, number | null, string | null, MotivoDaQuedaDoModelo]>([
    ["cota", 429, null, "cota"],
    ["servidor", 503, null, "falha_do_provedor"],
    ["tempo esgotado", null, "timeout", "tempo_esgotado"],
  ])("%s ⇒ uma tentativa na reserva, com provedor, modelo e motivo", (_nome, status, detalhe, motivo) => {
    expect(
      decidirQuedaDoModeloDeReserva({ reserva: RESERVA, status, detalhe, jaCaiuParaAReserva: false }),
    ).toEqual({
      acao: "tentar_reserva_do_modelo",
      provedorDeReserva: "deepseek",
      modeloDeReserva: "deepseek-chat",
      motivo,
    });
  });
});

describe("decidirQuedaDoModeloDeReserva — os proibidos não caem", () => {
  it.each<[string, number]>([
    ["400 de pedido", 400],
    ["422 de parâmetro", 422],
  ])("%s não repete a chamada em erro de pedido", (_nome, status) => {
    expect(
      decidirQuedaDoModeloDeReserva({ reserva: RESERVA, status, jaCaiuParaAReserva: false }),
    ).toBeNull();
  });
});

describe("decidirQuedaDoModeloDeReserva — UMA tentativa, sem laço", () => {
  it("depois de cair uma vez, a segunda pergunta devolve null mesmo com motivo permitido", () => {
    const primeira = decidirQuedaDoModeloDeReserva({
      reserva: RESERVA,
      status: 429,
      jaCaiuParaAReserva: false,
    });
    expect(primeira).not.toBeNull();
    // A reserva TAMBÉM falhou com 429: o freio é a tentativa, não o motivo.
    expect(
      decidirQuedaDoModeloDeReserva({ reserva: RESERVA, status: 429, jaCaiuParaAReserva: true }),
    ).toBeNull();
    expect(
      decidirQuedaDoModeloDeReserva({ reserva: RESERVA, status: 503, jaCaiuParaAReserva: true }),
    ).toBeNull();
  });
});

describe("decidirQuedaDoModeloDeReserva — qualquer provedor cadastrado é reserva", () => {
  it.each<[string, string]>([
    ["openrouter", "anthropic/claude-haiku-4.5"],
    ["deepseek", "deepseek-chat"],
    ["personalizado", "llama-3.3-70b"],
    ["google", "gemini-2.5-flash"],
  ])("o principal em %s não decide nada: a reserva vem da configuração", (provedorDaReserva, modelo) => {
    expect(
      decidirQuedaDoModeloDeReserva({
        reserva: { provider: provedorDaReserva, model: modelo },
        status: 429,
        jaCaiuParaAReserva: false,
      }),
    ).toMatchObject({ provedorDeReserva: provedorDaReserva, modeloDeReserva: modelo });
  });
});

describe("a política da ASSINATURA não muda", () => {
  it("provedorDeReserva continua só para o provedor por assinatura", () => {
    expect(provedorDeReserva(PROVEDOR_POR_ASSINATURA)).toBe("openai");
    for (const outro of ["openai", "anthropic", "google", "openrouter", "deepseek", "personalizado"]) {
      expect(provedorDeReserva(outro)).toBeNull();
    }
  });

  it("um 429 de provedor nativo sem reserva de assinatura continua sem queda", () => {
    expect(
      decidirQuedaDoProvedor({
        provider: "openrouter",
        status: 429,
        detalhe: null,
        temChaveDeReserva: true,
      }),
    ).toBeNull();
  });
});

describe("overrideLlmDoAgente — o par chega ao seam (ou não chega)", () => {
  const base = {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    credentialId: "cred-1",
  } as unknown as PublishedAgentConfig;

  it("sem reserva configurada, o override é o de hoje (sem a chave)", () => {
    const override = overrideLlmDoAgente(base);
    expect(override).toEqual({ provider: "openrouter", credentialId: "cred-1" });
    expect("reservaDeModelo" in override).toBe(false);
  });

  it("com provedor e modelo, a reserva entra", () => {
    expect(
      overrideLlmDoAgente({ ...base, reserveProvider: "deepseek", reserveModel: "deepseek-chat" }),
    ).toEqual({
      provider: "openrouter",
      credentialId: "cred-1",
      reservaDeModelo: { provider: "deepseek", model: "deepseek-chat" },
    });
  });

  it("par pela metade é configuração inválida: não entra (e o banco também recusa)", () => {
    expect(
      overrideLlmDoAgente({ ...base, reserveProvider: "deepseek", reserveModel: null }),
    ).toEqual({ provider: "openrouter", credentialId: "cred-1" });
    expect(
      overrideLlmDoAgente({ ...base, reserveProvider: "  ", reserveModel: "deepseek-chat" }),
    ).toEqual({ provider: "openrouter", credentialId: "cred-1" });
  });
});
