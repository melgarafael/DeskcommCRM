import { describe, expect, it } from "vitest";
import { responder } from "./respostas";

describe("assistente de ajuda — respostas automáticas", () => {
  it("responde saudação sem perder o roteiro", () => {
    const r = responder("Olá!");
    expect(r.texto).toMatch(/olá/i);
    expect(r.links.length).toBeGreaterThan(0);
  });

  it("leva dúvida de conexão para /app/connections", () => {
    const r = responder("o WhatsApp desconectou, e agora?");
    expect(r.links.some((l) => l.href === "/app/connections")).toBe(true);
  });

  it("leva dúvida de funil para o kanban", () => {
    const r = responder("como funciona o funil?");
    expect(r.links.some((l) => l.href === "/app/kanban")).toBe(true);
  });

  it("leva dúvida de atalho para o inbox", () => {
    const r = responder("quais os atalhos de teclado?");
    expect(r.links.some((l) => l.href === "/app/inbox")).toBe(true);
  });

  it("cai no fallback com links reais para pergunta desconhecida", () => {
    const r = responder("qual a previsão do tempo amanhã?");
    expect(r.texto).toMatch(/caixa de entrada/i);
    for (const l of r.links) {
      expect(l.href.startsWith("/app/")).toBe(true);
    }
  });

  it("ignora acento e caixa alta", () => {
    const r = responder("REUNIÃO como agendo?");
    expect(r.links.some((l) => l.href === "/app/agenda")).toBe(true);
  });
});
