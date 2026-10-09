import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { gerarAbordagemDeFormulario } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { formatarParaWhatsApp } from "@/lib/agent-engine/agent/formato-whatsapp";

vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfigById: async () => ({
    systemPrompt: "Você atende a clínica.",
    model: "m",
    provider: "anthropic",
    credentialId: null,
  }),
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: async () => ({ result: { text: "## **Hola**\\n\\nTenemos **2x1** hoy." } }),
}));

describe("formatarParaWhatsApp", () => {
  it("troca o \\n literal por salto de linha de verdade (caso medido)", () => {
    expect(
      formatarParaWhatsApp("¡Claro, Ana Claudia! 😊 Tómate tu tiempo.\\n\\nCualquier duda, aquí estoy."),
    ).toBe("¡Claro, Ana Claudia! 😊 Tómate tu tiempo.\n\nCualquier duda, aquí estoy.");
  });

  it("converte negrito de Markdown para o do WhatsApp", () => {
    expect(formatarParaWhatsApp("✨ **Endolifting de papada**: desde S/ 1,100")).toBe(
      "✨ *Endolifting de papada*: desde S/ 1,100",
    );
  });

  it("título de Markdown vira negrito", () => {
    expect(formatarParaWhatsApp("## Nuestros servicios\nEndolifting")).toBe(
      "*Nuestros servicios*\nEndolifting",
    );
  });

  it("não mexe no negrito que já está no formato do WhatsApp", () => {
    expect(formatarParaWhatsApp("El *endolifting* usa láser")).toBe("El *endolifting* usa láser");
  });

  it("junta linhas em branco em excesso e apara as pontas", () => {
    expect(formatarParaWhatsApp("  Hola 😊 \n\n\n\n¿En qué te ayudo?  ")).toBe("Hola 😊\n\n¿En qué te ayudo?");
  });
});

describe("formatarParaWhatsApp — o que não é ênfase não muda", () => {
  it("link com __ na query string sai intacto", () => {
    const link = "Pague aqui: https://loja.com/p?__hstc=123&__hssc=456";
    expect(formatarParaWhatsApp(link)).toBe(link);
  });

  it("** e __ colados em palavra (senha, código) saem intactos", () => {
    expect(formatarParaWhatsApp("Código: ab**cd**ef")).toBe("Código: ab**cd**ef");
    expect(formatarParaWhatsApp("ref a__b__c")).toBe("ref a__b__c");
  });

  it("caminho de link com __ sai intacto", () => {
    expect(formatarParaWhatsApp("Veja https://x.com/__init__")).toBe("Veja https://x.com/__init__");
    expect(formatarParaWhatsApp("https://x.com/__init__/docs")).toBe("https://x.com/__init__/docs");
    expect(formatarParaWhatsApp("o arquivo __init__.py")).toBe("o arquivo __init__.py");
  });

  it("ênfase colada em pontuação ainda converte, e __x__ é negrito", () => {
    expect(formatarParaWhatsApp("(**Oferta**), __hoje__!")).toBe("(*Oferta*), *hoje*!");
  });
});

describe("formatarParaWhatsApp — título com negrito dentro", () => {
  // O título rodava DEPOIS do negrito e reembrulhava: `## **X**` → `**X**`.
  it("não devolve os asteriscos duplos", () => {
    expect(formatarParaWhatsApp("## **Nuestros servicios**\nEndolifting")).toBe(
      "*Nuestros servicios*\nEndolifting",
    );
  });

  it("negrito no meio do título não vira negrito aninhado", () => {
    expect(formatarParaWhatsApp("### Planos com **Básico**")).toBe("*Planos com Básico*");
    expect(formatarParaWhatsApp("## *Já no formato*")).toBe("*Já no formato*");
  });
});

describe("o send_message formata ANTES da cadeia de envio", () => {
  // O teste puro acima fica verde se a chamada sumir do turno; este vigia a ligação.
  // A posição importa: os gates (corpo vazio, guardrails, bolhas) têm de medir o que sai.
  const fonte = readFileSync(join(__dirname, "inbound-turn.ts"), "utf8");
  const execute = fonte.slice(fonte.indexOf("send_message: tool({"));

  it("formata o corpo do modelo antes do corpo vazio e do runBeforeSend", () => {
    const formata = execute.indexOf("formatarParaWhatsApp(");
    expect(formata).toBeGreaterThan(-1);
    expect(formata).toBeLessThan(execute.indexOf("body.trim() === ''"));
    expect(formata).toBeLessThan(execute.indexOf("runBeforeSend("));
  });
});

describe("a mensagem escrita pela IA na automação sai no mesmo formato", () => {
  // `send_ai_message` e a prospecção mandam este texto ao cliente sem passar
  // pelo `send_message`: sem a formatação aqui, `**x**` chegava na tela.
  it("gerarAbordagemDeFormulario devolve o texto já formatado", async () => {
    const r = await gerarAbordagemDeFormulario({} as never, {} as never, {
      tenantId: "t",
      agentId: "a",
      leadId: "l",
      instrucao: "Cumprimente.",
      dados: {},
      origemDaAbordagem: "automacao",
    });
    expect(r).toEqual({ ok: true, texto: "*Hola*\n\nTenemos *2x1* hoy." });
  });
});
