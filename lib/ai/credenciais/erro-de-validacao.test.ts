import { describe, expect, it } from "vitest";
import { descreverErroDeValidacao } from "./erro-de-validacao";

describe("descreverErroDeValidacao", () => {
  it("401/403 é chave recusada, e aponta para onde pegar outra", () => {
    const r = descreverErroDeValidacao("auth_failed_401");
    expect(r.chaveErrada).toBe(true);
    expect(r.frase).toBe("O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.");
  });

  it("429 é limite do provedor", () => {
    expect(descreverErroDeValidacao("provider_status_429").frase).toBe(
      "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.",
    );
  });

  it("outro 4xx (402, 404…) é recusa com frase, não código cru", () => {
    const r = descreverErroDeValidacao("provider_status_402");
    expect(r.generico).toBe(false);
    expect(r.chaveErrada).toBe(true);
    expect(r.frase).toBe(
      "O provedor recusou a chave. Confira se ela está inteira e se a conta no provedor tem crédito.",
    );
    // O 429 continua com a frase própria.
    expect(descreverErroDeValidacao("provider_status_429").frase).toMatch(/limitou/);
  });

  it("5xx é provedor fora", () => {
    expect(descreverErroDeValidacao("provider_status_503").frase).toBe(
      "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.",
    );
  });

  it("timeout e rede são a mesma frase", () => {
    const esperado = "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.";
    expect(descreverErroDeValidacao("AbortError").frase).toBe(esperado);
    expect(descreverErroDeValidacao("TimeoutError").frase).toBe(esperado);
    expect(descreverErroDeValidacao("network_error").frase).toBe(esperado);
    // `fetch` do Node lança TypeError p/ falha de rede/DNS (undici não nomeia
    // isso `network_error`). Achado rodando a spec de e2e contra o provedor
    // real: sem este caso, o card mostrava "Falha na validação (TypeError)."
    expect(descreverErroDeValidacao("TypeError").frase).toBe(esperado);
  });

  it("código desconhecido não some: vira frase genérica COM o código", () => {
    const r = descreverErroDeValidacao("unknown_provider:foo");
    expect(r.chaveErrada).toBe(false);
    expect(r.frase).toBe("Falha na validação (unknown_provider:foo).");
  });

  it("chave do Jev: diz QUEM recusou, e os outros provedores seguem com a frase comum", () => {
    expect(descreverErroDeValidacao("auth_failed_401", "typesafe")).toEqual({
      frase: "A TypeSafe recusou a chave. Confira se copiou inteira ou gere uma nova.",
      chaveErrada: true,
      generico: false,
    });
    expect(descreverErroDeValidacao("provider_status_402", "typesafe").frase).toBe(
      "A TypeSafe recusou a chave. Confira se ela está inteira e se a conta na TypeSafe tem crédito.",
    );
    expect(descreverErroDeValidacao("auth_failed_401", "anthropic").frase).toMatch(/^O provedor recusou/);
    // Fora do ar não é recusa: a frase comum serve.
    expect(descreverErroDeValidacao("provider_status_503", "typesafe").frase).toMatch(/^O provedor está fora/);
  });

  it("null é string vazia", () => {
    expect(descreverErroDeValidacao(null).frase).toBe("");
  });
});
