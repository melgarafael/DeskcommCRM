import { describe, expect, it } from "vitest";

import { createTemplateSchema } from "@/lib/schemas/templates";

describe("createTemplateSchema", () => {
  it("aceita template válido pessoal", () => {
    const r = createTemplateSchema.safeParse({ title: "Saudação", body: "Oi {{primeiro_nome}}!" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.shared).toBe(false);
  });
  it("aceita shared + shortcut", () => {
    const r = createTemplateSchema.safeParse({ title: "Fechamento", body: "Fechado!", shortcut: "fech", shared: true });
    expect(r.success).toBe(true);
  });
  it("aceita body vazio: é assim que nasce o recurso de ÁUDIO (#2833)", () => {
    // O conteúdo de um recurso de áudio é o ARQUIVO, que entra por
    // `POST /message-templates/:id/midias` logo depois do create. A exigência de
    // mensagem no recurso de TEXTO é da tela (o textarea é `required`), que é
    // onde a pessoa pode corrigi-la — a rota não tem como distinguir "texto
    // vazio" de "áudio a caminho" sem uma coluna `tipo`, que este PR não tem.
    const r = createTemplateSchema.safeParse({ title: "Áudio preço", body: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.body).toBe("");
  });
  it("rejeita title vazio", () => {
    expect(createTemplateSchema.safeParse({ title: "", body: "x" }).success).toBe(false);
  });
  it("rejeita body gigante (>4096)", () => {
    expect(createTemplateSchema.safeParse({ title: "x", body: "a".repeat(5000) }).success).toBe(false);
  });
});
