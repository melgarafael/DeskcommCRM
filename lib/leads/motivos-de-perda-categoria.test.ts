/**
 * Regras NOVAS da issue #1537 — categoria do motivo de perda.
 *
 * O arquivo testado é `motivos-de-perda-do-funil.ts`, que já era a régua da
 * janela de perder; aqui está o que ele passou a responder a mais: o formato
 * `{ label, categoria }` convivendo com o texto puro, e a resolução da
 * categoria usada pelo filtro do quadro, pelo `crm_list_leads` e pelo relatório.
 */
import { describe, it, expect } from "vitest";

import {
  categoriaDoMotivo,
  motivosComCategoriaDoFunil,
  motivosDaCategoria,
  motivosDoFunil,
} from "./motivos-de-perda-do-funil";
import { recusaDeMotivoForaDoVocabulario } from "./motivo-da-perda";

describe("motivosComCategoriaDoFunil (#1537)", () => {
  it("lê texto puro e objeto na MESMA lista, sem migrar nada", () => {
    const settings = {
      lost_reasons: ["Adiou", { label: "Não tinha o perfil", categoria: "Mérito" }],
    };
    expect(motivosComCategoriaDoFunil(settings)).toEqual([
      { valor: "Adiou" },
      { valor: "Não tinha o perfil", categoria: "Mérito" },
    ]);
    // O contrato antigo (só rótulos) segue intacto — é o que as telas usam.
    expect(motivosDoFunil(settings)).toEqual(["Adiou", "Não tinha o perfil"]);
  });

  it("sem `lost_reasons` ou sem array é lista vazia, nunca exceção", () => {
    expect(motivosComCategoriaDoFunil(null)).toEqual([]);
    expect(motivosComCategoriaDoFunil(undefined)).toEqual([]);
    expect(motivosComCategoriaDoFunil({})).toEqual([]);
    expect(motivosComCategoriaDoFunil({ lost_reasons: "Preço" })).toEqual([]);
  });

  it("item sujo não derruba os bons: objeto sem label sai, categoria vazia fica só no motivo", () => {
    const settings = {
      lost_reasons: [
        { categoria: "Cliente" },
        { label: "   " },
        { label: "Cliente sombra", categoria: "" },
        "Preço",
      ],
    };
    expect(motivosComCategoriaDoFunil(settings)).toEqual([
      { valor: "Cliente sombra" },
      { valor: "Preço" },
    ]);
  });

  it("deduplica por rótulo aparado e preserva o texto COMO ESTÁ NO BANCO", () => {
    const settings = { lost_reasons: [" Preço ", "Preço"] };
    expect(motivosComCategoriaDoFunil(settings)).toEqual([{ valor: " Preço " }]);
  });

  it("rótulo além do teto do PATCH não entra", () => {
    expect(motivosComCategoriaDoFunil({ lost_reasons: ["x".repeat(81)] })).toEqual([]);
  });
});

describe("categoriaDoMotivo (#1537)", () => {
  it("a categoria DO FUNIL sobrescreve a padrão do canônico", () => {
    const settings = { lost_reasons: [{ label: "price", categoria: "Concorrência" }] };
    expect(categoriaDoMotivo("price", settings)).toBe("Concorrência");
  });

  it("motivo canônico cadastrado como TEXTO PURO herda o padrão", () => {
    expect(categoriaDoMotivo("price", { lost_reasons: ["price"] })).toBe("Nós");
    expect(categoriaDoMotivo("no_response", {})).toBe("Ausência");
    expect(categoriaDoMotivo("cancelled_by_customer", null)).toBe("Cliente");
  });

  it("`other` e motivos inventados ficam SEM categoria — não se inventa fato", () => {
    expect(categoriaDoMotivo("other", {})).toBeUndefined();
    expect(categoriaDoMotivo("motivo_do_operador", { lost_reasons: ["motivo_do_operador"] })).toBeUndefined();
    expect(categoriaDoMotivo("", {})).toBeUndefined();
    expect(categoriaDoMotivo("   ", {})).toBeUndefined();
  });

  it("motivo de sistema não ganha categoria: transferência não é perda", () => {
    expect(categoriaDoMotivo("moved_to_another_pipeline", {})).toBeUndefined();
  });
});

describe("motivosDaCategoria (#1537) — o filtro de categoria vira lista de rótulos", () => {
  it("junta o padrão do produto com o que os funis cadastraram", () => {
    const permitidos = motivosDaCategoria(
      [{ settings: { lost_reasons: [{ label: "Sem perfil", categoria: "Nós" }] } }],
      "Nós",
    );
    expect(permitidos).toContain("price");
    expect(permitidos).toContain("product_unavailable");
    expect(permitidos).toContain("Sem perfil");
    expect(permitidos).not.toContain("no_response");
  });

  it("sem funil nenhum só o padrão responde", () => {
    expect(motivosDaCategoria([], "Ausência")).toEqual(["no_response"]);
  });

  it("categoria vazia ou desconhecida devolve lista vazia — filtro que acha nada", () => {
    expect(motivosDaCategoria([], "")).toEqual([]);
    expect(motivosDaCategoria([], "Inexistente")).toEqual([]);
  });
});

describe("recusaDeMotivoForaDoVocabulario aceita motivo com categoria (#1537)", () => {
  const settingsDoFunil = {
    lost_reasons: ["Adiou", { label: "Não tinha o perfil", categoria: "Mérito" }],
  };

  it("o label do objeto é aceito, como o trigger aceita", () => {
    expect(
      recusaDeMotivoForaDoVocabulario({ motivo: "Não tinha o perfil", settingsDoFunil }),
    ).toBeNull();
    expect(recusaDeMotivoForaDoVocabulario({ motivo: "Adiou", settingsDoFunil })).toBeNull();
  });

  it("motivo fora da lista continua recusado", () => {
    expect(recusaDeMotivoForaDoVocabulario({ motivo: "Mérito", settingsDoFunil })?.codigo).toBe(
      "lost_reason_invalid",
    );
  });
});
