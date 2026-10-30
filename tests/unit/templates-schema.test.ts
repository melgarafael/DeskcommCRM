import { describe, expect, it } from "vitest";

import { camposDoUploadDeTemplateSchema, createTemplateSchema, updateTemplateSchema } from "@/lib/schemas/templates";

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

describe("snapshot esperado da lista de mídias", () => {
  const midia = {
    storage_path: "11111111-1111-4111-8111-111111111111/templates/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.ogg",
    media_mime: "audio/ogg", media_size_bytes: 42,
    nome_original: 'Áudio "apresentação" + 10% \\ reserva.ogg',
  };

  it("preserva o JSON integral, incluindo caracteres e metadados que não são destino de upload", () => {
    const r = updateTemplateSchema.parse({ title: "Título", midias_esperadas: [midia] });
    expect(r.midias_esperadas).toEqual([midia]);
  });

  it("[] é uma precondição válida; null não é lista", () => {
    expect(camposDoUploadDeTemplateSchema.safeParse({ midias_esperadas: [] }).success).toBe(true);
    expect(camposDoUploadDeTemplateSchema.safeParse({ midias_esperadas: null }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ title: "Título", midias_esperadas: null }).success).toBe(false);
  });

  it("snapshot sozinho não é uma mutação", () => {
    expect(updateTemplateSchema.safeParse({ midias_esperadas: [] }).success).toBe(false);
  });
});
