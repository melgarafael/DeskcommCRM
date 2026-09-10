/**
 * O esforço de raciocínio é o que separa "a IA respondeu" de "a IA demorou".
 *
 * Medido na instalação do piloto em 10/09/2026: seis respostas de atendimento,
 * de 23 a 34 tokens de TEXTO cada, custaram de 450 a 2047 tokens de SAÍDA — o
 * resto era raciocínio invisível. O `agent_turn` levou 28s em média e 50s no
 * pior caso, e sozinho respondia pela maior parte dos 42s de mediana que o
 * cliente esperava no WhatsApp.
 *
 * A/B contra a API real, mesmo prompt, só variando o esforço:
 *   padrão   8954ms — 515 tokens de saída (448 de raciocínio)
 *   low      2252ms — 117 tokens de saída ( 64 de raciocínio)
 *   minimal  1527ms —  20 tokens de saída (  0 de raciocínio)
 *
 * Daí o default `low`: 4× mais rápido, resposta equivalente.
 */
import { describe, expect, it } from "vitest";

import { ehModeloDeRaciocinio, esforcoDeRaciocinio } from "./esforco-de-raciocinio";

describe("ehModeloDeRaciocinio", () => {
  it("reconhece as famílias que raciocinam", () => {
    for (const m of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "o1", "o1-mini", "o3", "o3-mini", "o4-mini"]) {
      expect(ehModeloDeRaciocinio(m), m).toBe(true);
    }
  });

  it("não reconhece os que não raciocinam", () => {
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "chatgpt-4o-latest"]) {
      expect(ehModeloDeRaciocinio(m), m).toBe(false);
    }
  });

  it("trata `gpt-5-chat` como NÃO-raciocínio", () => {
    // É a variante conversacional da família 5: aceitar `reasoning_effort` nela
    // é 400 na OpenAI, e um 400 aqui derruba o turno inteiro.
    expect(ehModeloDeRaciocinio("gpt-5-chat")).toBe(false);
    expect(ehModeloDeRaciocinio("gpt-5-chat-latest")).toBe(false);
  });

  it("ignora o prefixo de roteamento do gateway", () => {
    // Strings tipo "openai/gpt-5-mini" chegam de gateway; o discriminador é o
    // NOME do modelo, não o caminho até ele.
    expect(ehModeloDeRaciocinio("openai/gpt-5-mini")).toBe(true);
    expect(ehModeloDeRaciocinio("openai/gpt-4o")).toBe(false);
  });

  it("é indiferente a caixa e a espaço em volta", () => {
    expect(ehModeloDeRaciocinio("  GPT-5-Mini ")).toBe(true);
  });

  it("não confunde nome que apenas COMEÇA parecido", () => {
    // `o1` é modelo; `omni-moderation` só começa com "o". Casar por prefixo de
    // letra transformaria metade do catálogo em modelo de raciocínio.
    expect(ehModeloDeRaciocinio("omni-moderation-latest")).toBe(false);
    expect(ehModeloDeRaciocinio("gpt-55-turbo")).toBe(false);
  });
});

describe("esforcoDeRaciocinio", () => {
  const provider = "openai";

  it("aplica o padrão quando o modelo raciocina e ninguém configurou", () => {
    expect(esforcoDeRaciocinio({ provider, modelId: "gpt-5-mini", padrao: "low" })).toBe("low");
  });

  it("respeita o que a organização configurou", () => {
    expect(
      esforcoDeRaciocinio({ provider, modelId: "gpt-5-mini", configurado: "high", padrao: "low" }),
    ).toBe("high");
  });

  it("devolve null para modelo que NÃO raciocina, mesmo com a org pedindo", () => {
    // Mandar o parâmetro assim mesmo trocaria lentidão por 400 — de longe pior.
    expect(
      esforcoDeRaciocinio({ provider, modelId: "gpt-4o", configurado: "high", padrao: "low" }),
    ).toBeNull();
  });

  it("devolve null para provider que não é OpenAI", () => {
    // `reasoning_effort` é vocabulário da OpenAI. A Anthropic tem outro
    // mecanismo, e mandar este campo para lá não é lento — é erro.
    expect(esforcoDeRaciocinio({ provider: "anthropic", modelId: "gpt-5-mini", padrao: "low" })).toBeNull();
  });

  it("devolve null quando o padrão é desligado explicitamente", () => {
    // A saída para quem quer o comportamento do provider, sem opinião nossa.
    expect(esforcoDeRaciocinio({ provider, modelId: "gpt-5-mini", padrao: "provider" })).toBeNull();
  });

  it("o configurado vence mesmo quando o padrão está desligado", () => {
    expect(
      esforcoDeRaciocinio({ provider, modelId: "gpt-5-mini", configurado: "minimal", padrao: "provider" }),
    ).toBe("minimal");
  });

  it("ignora valor configurado que não existe, caindo no padrão", () => {
    // jsonb livre no banco: alguém escreve "rapido" e o turno não pode quebrar.
    expect(
      esforcoDeRaciocinio({ provider, modelId: "gpt-5-mini", configurado: "rapido", padrao: "low" }),
    ).toBe("low");
  });
});
