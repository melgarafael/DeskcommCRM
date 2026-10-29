import { describe, expect, it } from "vitest";

import type { SheetMatrix } from "@/lib/planilha/ler-arquivo";
import { lerPlanilhaDeProspeccao, PLANILHA_MAX_LINHAS } from "@/lib/prospecting/planilha";

function ok(sheet: SheetMatrix) {
  const r = lerPlanilhaDeProspeccao(sheet);
  if ("erro" in r) throw new Error(r.erro);
  return r;
}

describe("lerPlanilhaDeProspeccao", () => {
  it("lê cabeçalho em português e normaliza o telefone para E.164", () => {
    const r = ok({
      headers: ["Empresa", "Telefone", "Site", "Segmento", "Cidade"],
      rows: [["Padaria Exemplo", "(11) 99999-0000", "https://exemplo.com.br", "padaria", "São Paulo"]],
    });
    expect(r.erros).toEqual([]);
    expect(r.candidatos).toHaveLength(1);
    expect(r.candidatos[0]).toMatchObject({
      key: "planilha:+5511999990000",
      name: "Padaria Exemplo",
      phone: "+5511999990000",
      website: "https://exemplo.com.br/",
      category: "padaria",
      address: "São Paulo",
      maps_url: null,
      rating: null,
      reviews: null,
    });
  });

  it("lê cabeçalho em espanhol, sem acento e sem caixa", () => {
    const r = ok({
      headers: ["NOMBRE", "Teléfono", "Sitio Web", "Dirección"],
      rows: [["Panadería Sol", "+351 912 345 678", "https://sol.pt", "Lisboa"]],
    });
    expect(r.candidatos[0]).toMatchObject({
      name: "Panadería Sol",
      phone: "+351912345678",
      website: "https://sol.pt/",
      address: "Lisboa",
    });
  });

  it("aceita telefone estrangeiro com +", () => {
    const r = ok({ headers: ["empresa", "telefone"], rows: [["Empresa PT", "+351 912 345 678"]] });
    expect(r.candidatos[0]?.phone).toBe("+351912345678");
  });

  it("recusa telefone vazio e curto com o número da linha como a planilha mostra", () => {
    const r = ok({
      headers: ["empresa", "telefone"],
      rows: [
        ["Boa", "(11) 99999-0000"],
        ["Sem fone", ""],
        ["Fone curto", "1234"],
      ],
    });
    expect(r.candidatos).toHaveLength(1);
    expect(r.erros).toEqual([
      { linha: 3, motivo: "Sem telefone válido." },
      { linha: 4, motivo: "Sem telefone válido." },
    ]);
  });

  it("telefone repetido no arquivo: fica só a primeira, a outra aponta a linha", () => {
    const r = ok({
      headers: ["empresa", "telefone"],
      rows: [
        ["Primeira", "(11) 99999-0000"],
        ["Segunda", "11 99999-0000"],
      ],
    });
    expect(r.candidatos.map((c) => c.name)).toEqual(["Primeira"]);
    expect(r.erros).toEqual([{ linha: 3, motivo: "Telefone repetido na planilha (linha 2)." }]);
  });

  it("recusa nome de uma letra", () => {
    const r = ok({ headers: ["empresa", "telefone"], rows: [["A", "(11) 99999-0000"]] });
    expect(r.candidatos).toEqual([]);
    expect(r.erros).toEqual([{ linha: 2, motivo: "Sem nome da empresa." }]);
  });

  it("mais de 500 linhas de dados recusa o arquivo inteiro", () => {
    const rows = Array.from({ length: PLANILHA_MAX_LINHAS + 1 }, (_, i) => [
      `Empresa ${i}`,
      `(11) 9${String(i).padStart(4, "0")}-0000`,
    ]);
    const r = lerPlanilhaDeProspeccao({ headers: ["empresa", "telefone"], rows });
    expect(r).toEqual({ erro: "Máximo de 500 linhas de dados." });
  });

  it("aceita exatamente 500 linhas", () => {
    const rows = Array.from({ length: PLANILHA_MAX_LINHAS }, (_, i) => [
      `Empresa ${i}`,
      `(11) 9${String(i).padStart(4, "0")}-0000`,
    ]);
    expect(ok({ headers: ["empresa", "telefone"], rows }).candidatos).toHaveLength(500);
  });

  it("sem coluna de telefone: erro do arquivo listando as colunas encontradas", () => {
    const r = lerPlanilhaDeProspeccao({ headers: ["empresa", "cidade"], rows: [["X Ltda", "Rio"]] });
    expect(r).toHaveProperty("erro");
    const erro = "erro" in r ? r.erro : "";
    expect(erro).toContain("empresa, cidade");
    expect(erro).toContain("telefone");
  });

  it("sem coluna de nome: erro do arquivo", () => {
    const r = lerPlanilhaDeProspeccao({ headers: ["telefone", "cidade"], rows: [["11999990000", "Rio"]] });
    expect(r).toHaveProperty("erro");
  });

  it("socials: só http(s); javascript: é descartado", () => {
    const r = ok({
      headers: ["empresa", "telefone", "instagram", "facebook"],
      rows: [
        [
          "Loja",
          "(11) 99999-0000",
          "javascript:alert(1)",
          "https://facebook.com/loja https://instagram.com/loja",
        ],
      ],
    });
    expect(r.candidatos[0]?.socials).toEqual([
      "https://facebook.com/loja",
      "https://instagram.com/loja",
    ]);
  });

  it("site: só http(s); domínio sem protocolo ganha https://; javascript: vira nulo", () => {
    const r = ok({
      headers: ["empresa", "telefone", "site"],
      rows: [
        ["Loja A", "(11) 99999-0001", "www.loja-a.com.br"],
        ["Loja B", "(11) 99999-0002", "javascript:alert(1)"],
        ["Loja C", "(11) 99999-0003", "http://loja-c.com.br/"],
      ],
    });
    expect(r.candidatos.map((c) => c.website)).toEqual([
      "https://www.loja-a.com.br/",
      null,
      "http://loja-c.com.br/",
    ]);
  });

  it("emails: até 5, separados por vírgula, ponto e vírgula ou espaço", () => {
    const r = ok({
      headers: ["empresa", "telefone", "email"],
      rows: [["Loja", "(11) 99999-0000", "a@x.com; b@x.com, c@x.com d@x.com e@x.com f@x.com sem-arroba"]],
    });
    expect(r.candidatos[0]?.emails).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
  });

  it("lista as colunas que não reconhece", () => {
    const r = ok({
      headers: ["empresa", "telefone", "observação interna"],
      rows: [["Loja", "(11) 99999-0000", "x"]],
    });
    expect(r.colunasIgnoradas).toEqual(["observação interna"]);
  });

  it("linha totalmente em branco é ignorada sem erro, mas conta na numeração", () => {
    const r = ok({
      headers: ["empresa", "telefone"],
      rows: [
        ["Um", "(11) 99999-0000"],
        ["", ""],
        ["", "(11) 98888-0000"],
      ],
    });
    expect(r.candidatos).toHaveLength(1);
    expect(r.erros).toEqual([{ linha: 4, motivo: "Sem nome da empresa." }]);
  });
});
