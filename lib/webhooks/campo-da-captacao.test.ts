import { describe, it, expect } from "vitest";

import { customFieldSchema } from "@/lib/schemas/settings";
import {
  MAX_CAMPOS_DO_FUNIL,
  TIPOS_CADASTRAVEIS_DA_CAPTACAO,
  chaveCadastravel,
  comNovoCampo,
  rotuloSugerido,
  tipoSugerido,
} from "@/lib/webhooks/campo-da-captacao";

describe("chaveCadastravel", () => {
  it("aceita o que o formulário costuma mandar", () => {
    for (const k of ["servico", "Telefone", "campo_1", "idv"])
      expect(chaveCadastravel(k)).toBe(true);
  });
  it("recusa o que customFieldSchema recusa (não cria definição que a API rejeitaria)", () => {
    for (const k of [
      "e-mail",
      "campo 1",
      "1campo",
      "",
      "a".repeat(41),
      "fields[x][value]",
      "__refer",
    ])
      expect(chaveCadastravel(k)).toBe(false);
  });
});

describe("rotuloSugerido", () => {
  it("troca _ por espaço e põe a primeira maiúscula", () =>
    expect(rotuloSugerido("servico_desejado")).toBe("Servico desejado"));
  it("ignora _ à esquerda", () => expect(rotuloSugerido("_origem")).toBe("Origem"));
  it("chave só de símbolos volta como veio", () => expect(rotuloSugerido("___")).toBe("___"));
});

describe("tipoSugerido", () => {
  it.each([
    ["maria@example.com", "email"],
    ["https://site.example/x", "url"],
    ["2026-09-30", "date"],
    ["2026-09-30T10:00:00Z", "date"],
    ["+55 (11) 98888-7777", "phone"],
    ["11988887777", "phone"],
    ["42", "number"],
    ["3,5", "number"],
    ["true", "boolean"],
    ["quero um orçamento", "text"],
    ["x".repeat(81), "textarea"],
    ["linha 1\nlinha 2", "textarea"],
  ])("%s → %s", (valor, tipo) => expect(tipoSugerido(valor)).toBe(tipo));
  it("valor que não é texto", () => {
    expect(tipoSugerido(true)).toBe("boolean");
    expect(tipoSugerido(7)).toBe("number");
    expect(tipoSugerido(null)).toBe("text");
  });
  it("todo tipo devolvido é um que a tela oferece", () => {
    for (const v of [
      "a@b.co",
      "http://x.y",
      "2026-01-01",
      "11999990000",
      "9",
      "true",
      "oi",
      "x".repeat(90),
    ])
      expect(TIPOS_CADASTRAVEIS_DA_CAPTACAO).toContain(tipoSugerido(v));
  });
});

describe("comNovoCampo", () => {
  const existentes = [{ key: "servico", label: "Serviço", type: "text" as const }];

  it("acrescenta no fim e preserva o que já existia, na ordem", () => {
    const r = comNovoCampo(existentes, "cidade", " Cidade ", "text");
    expect(r).toEqual({
      ok: true,
      fields: [...existentes, { key: "cidade", label: "Cidade", type: "text" }],
    });
  });
  it("o que grava passa em customFieldSchema (a server action não vai recusar)", () => {
    const r = comNovoCampo([], "cidade", "Cidade", "text");
    expect(r.ok && r.fields.every((f) => customFieldSchema.safeParse(f).success)).toBe(true);
  });
  it("não duplica chave já cadastrada", () =>
    expect(comNovoCampo(existentes, "servico", "Outro", "text")).toEqual({
      ok: false,
      motivo: "ja_cadastrado",
    }));
  it("recusa chave que a API recusaria", () =>
    expect(comNovoCampo(existentes, "e-mail", "E-mail", "email")).toEqual({
      ok: false,
      motivo: "chave_invalida",
    }));
  it("recusa rótulo vazio", () =>
    expect(comNovoCampo(existentes, "cidade", "   ", "text")).toEqual({
      ok: false,
      motivo: "rotulo_vazio",
    }));
  it("respeita o teto de campos do funil", () => {
    const cheio = Array.from({ length: MAX_CAMPOS_DO_FUNIL }, (_, i) => ({
      key: `c${i}`,
      label: `C${i}`,
      type: "text" as const,
    }));
    expect(comNovoCampo(cheio, "novo", "Novo", "text")).toEqual({ ok: false, motivo: "limite" });
  });
  it("não muda a lista recebida", () => {
    const antes = [...existentes];
    comNovoCampo(existentes, "cidade", "Cidade", "text");
    expect(existentes).toEqual(antes);
  });
});
