import { describe, expect, it } from "vitest";
import { montarContextoDaRevisao } from "./contexto-da-revisao";

describe("contexto de elegibilidade do revisor", () => {
  it("conserva quem declarou requisito e pergunta seguinte, sem misturar regra/perfil", () => {
    const c = montarContextoDaRevisao([
      { direction: "inbound", body: "Sou da categoria A do programa." },
      { direction: "outbound", body: "Vamos verificar condições da demonstração." },
      { direction: "inbound", body: "Quantas sessões posso fazer?" },
    ], "Cliente interessado.", "2026-01-01T10:00:00Z", "America/Sao_Paulo");
    expect(c.mensagens.map(m => m.papel)).toEqual(["cliente", "atendente", "cliente"]);
    expect(c.mensagens[0]?.texto).toContain("categoria A");
    expect(c.mensagens.at(-1)?.texto).toBe("Quantas sessões posso fazer?");
    expect(c).not.toHaveProperty("organization_id");
    expect(c).not.toHaveProperty("contact_id");
    expect(c.limitado).toBe(false);
  });
  it("preserva perfil inicial e pergunta atual de histórico colado sem ultrapassar orçamento", () => {
    const body = "Cliente: pertenço à categoria A.\n" + "Resposta anterior. ".repeat(6000) + "\nCliente: qual a oferta aplicável?";
    const c = montarContextoDaRevisao([{ direction: "inbound", body }], null, "2026-01-01T10:00:00Z", "UTC");
    expect(c.mensagens[0]?.texto).toContain("categoria A");
    expect(c.mensagens[0]?.texto).toContain("qual a oferta aplicável");
    expect(c.mensagens[0]?.texto.length).toBeLessThanOrEqual(48000);
    expect(c.limitado).toBe(true);
  });
  it("limita histórico/resumo sem modificar mensagens do chamador", () => {
    const input = Array.from({ length: 20 }, (_, i) => ({ direction: "inbound", body: `${i}: ` + "z".repeat(10000) }));
    const original = JSON.stringify(input);
    const c = montarContextoDaRevisao(input, "r".repeat(5000), "2026-01-01T10:00:00Z", "UTC");
    expect(c.mensagens.length).toBeLessThanOrEqual(100);
    expect(c.mensagens.reduce((n, m) => n + m.texto.length, 0)).toBeLessThanOrEqual(48000);
    expect(c.mensagens.at(-1)?.texto).toContain("19:");
    expect(c.resumo?.length).toBe(4000);
    expect(c.limitado).toBe(true);
    expect(JSON.stringify(input)).toBe(original);
  });
  it("mantém inteira uma conversa na janela de vinte mensagens, inclusive o perfil inicial", () => {
    const input = Array.from({ length: 20 }, (_, i) => ({ direction: i % 2 ? "outbound" : "inbound", body: `${i}: ` + "x".repeat(1000) }));
    const c = montarContextoDaRevisao(input, "Resumo conhecido", "2026-01-01T10:00:00Z", "UTC");
    expect(c.mensagens.map(m => m.texto)).toEqual(input.map(m => m.body));
    expect(c.limitado).toBe(false);
  });
});
