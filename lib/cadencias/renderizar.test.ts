import { describe, expect, it } from "vitest";

import { renderizarComLead } from "./renderizar";

describe("renderizarComLead", () => {
  it("substitui primeiro_nome, nome, vendedor e segmento", () => {
    const out = renderizarComLead("Oi {{primeiro_nome}} ({{nome}}), aqui é {{vendedor}} de {{segmento}}.", {
      nomeDoContato: "Maria Souza",
      nomeDoVendedor: "Luiz",
      segmento: "papel-e-celulose",
    });
    expect(out).toBe("Oi Maria (Maria Souza), aqui é Luiz de papel-e-celulose.");
  });

  it("variável desconhecida fica visível, sem lançar", () => {
    const out = renderizarComLead("Preço: {{preco}}", {
      nomeDoContato: "Maria",
      nomeDoVendedor: null,
      segmento: "",
    });
    expect(out).toBe("Preço: {{preco}}");
  });

  it("variável conhecida sem dado (empresa/cargo) fica visível, nunca some", () => {
    const out = renderizarComLead("Vi que a {{empresa}} contratou {{cargo}}.", {
      nomeDoContato: "Maria",
      nomeDoVendedor: null,
      segmento: "",
    });
    expect(out).toBe("Vi que a {{empresa}} contratou {{cargo}}.");
  });

  it("vendedor ausente fica visível (não vira string vazia)", () => {
    const out = renderizarComLead("{{vendedor}}", { nomeDoContato: "Maria", nomeDoVendedor: null, segmento: "" });
    expect(out).toBe("{{vendedor}}");
  });

  it("contato sem nome: primeiro_nome e nome ficam visíveis", () => {
    const out = renderizarComLead("Oi {{primeiro_nome}}", { nomeDoContato: null, nomeDoVendedor: null, segmento: "" });
    expect(out).toBe("Oi {{primeiro_nome}}");
  });
});
