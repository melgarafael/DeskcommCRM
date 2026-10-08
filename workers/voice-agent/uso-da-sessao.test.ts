import { describe, expect, it } from "vitest";

import { PURPOSE_DA_VOZ, linhaDaLigacao, somarUsoDaResposta, usoVazio } from "./uso-da-sessao";

/** Formato de `response.done.response.usage` da OpenAI Realtime. */
const USO_DE_UMA_RESPOSTA = {
  total_tokens: 330,
  input_tokens: 250,
  output_tokens: 80,
  input_token_details: { text_tokens: 50, audio_tokens: 200, cached_tokens: 40 },
  output_token_details: { text_tokens: 20, audio_tokens: 60 },
};

describe("uso da sessão de voz", () => {
  it("soma o uso de cada response.done", () => {
    const uso = somarUsoDaResposta(somarUsoDaResposta(usoVazio(), USO_DE_UMA_RESPOSTA), USO_DE_UMA_RESPOSTA);
    expect(uso).toEqual({
      respostas: 2,
      entrada: 500,
      saida: 160,
      entradaAudio: 400,
      entradaTexto: 100,
      entradaCache: 80,
      saidaAudio: 120,
      saidaTexto: 40,
    });
  });

  it("response.done sem usage (resposta cancelada) não conta", () => {
    expect(somarUsoDaResposta(usoVazio(), undefined)).toEqual(usoVazio());
    expect(somarUsoDaResposta(usoVazio(), null)).toEqual(usoVazio());
  });

  it("campo fora do formato vira 0, nunca NaN", () => {
    const uso = somarUsoDaResposta(usoVazio(), { input_tokens: "muitos", output_tokens: -3 });
    expect(uso.entrada).toBe(0);
    expect(uso.saida).toBe(0);
    expect(uso.respostas).toBe(1);
  });

  it("a linha da ligação leva tokens medidos, duração e custo NULO (preço desconhecido, não zero)", () => {
    const uso = somarUsoDaResposta(usoVazio(), USO_DE_UMA_RESPOSTA);
    expect(
      linhaDaLigacao({
        organizationId: "org1",
        agentId: "ag1",
        contactId: null,
        modelo: "gpt-realtime",
        uso,
        duracaoMs: 42_000,
        erro: null,
      }),
    ).toEqual({
      organization_id: "org1",
      agent_id: "ag1",
      contact_id: null,
      purpose: PURPOSE_DA_VOZ,
      provider: "openai",
      model: "gpt-realtime",
      input_tokens: 250,
      output_tokens: 80,
      cost_cents: null,
      latency_ms: 42_000,
      erro: null,
    });
  });

  it("handshake recusado vira linha de erro", () => {
    const linha = linhaDaLigacao({
      organizationId: "org1",
      agentId: "ag1",
      contactId: "c1",
      modelo: "gpt-realtime",
      uso: usoVazio(),
      duracaoMs: 300,
      erro: { message: "handshake rejeitado: invalid_api_key", status: 401 },
    });
    expect(linha.erro).toEqual({ message: "handshake rejeitado: invalid_api_key", status: 401 });
    expect(linha.input_tokens).toBe(0);
  });
});
