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

  it("null é string vazia", () => {
    expect(descreverErroDeValidacao(null).frase).toBe("");
  });
});
