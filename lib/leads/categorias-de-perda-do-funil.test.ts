/**
 * AS CATEGORIAS DE PERDA DO FUNIL (#4437) — a régua que a tela de Funis, o
 * filtro do quadro e o relatório "Perdas" passam a compartilhar.
 *
 * O defeito que estes casos trancam tem duas caras, e as duas aparecem no mesmo
 * funil instalado:
 *
 *   1. a lista era do PRODUTO (Cliente, Concorrência, Mérito, Nós, Ausência),
 *      fixa no código — a organização não criava "Risco"/"Operacional" nem
 *      escondia "Mérito";
 *   2. a categoria de cada motivo era indexada pelo TEXTO dele, então renomear
 *      o motivo ("Possível fraude" → "Fraude confirmada") apagava a categoria.
 *      O caso real do "Risco" gravado à mão antes da tela existir é o controle:
 *      ele tem de sobreviver ao rename e ao primeiro save, sem migration.
 */
import { describe, expect, it } from "vitest";

import { CATEGORIAS_DE_PERDA } from "@/lib/schemas/leads";

import {
  SEM_CATEGORIA,
  categoriasDeclaradasDoFunil,
  categoriasDoFunil,
  categoriasEditaveisDoFunil,
  categoriasQueSobrevivemAoTexto,
  categoriasUsadasPelosMotivos,
  rotulosDaCaixaDeMotivos,
} from "./motivos-de-perda-do-funil";

/** O funil da issue: dois motivos administrativos sem categoria e o "Risco" à mão. */
const FUNIL_DA_ISSUE = {
  lost_reasons: [
    "É fornecedor",
    "Card duplicado",
    { label: "Possível fraude", categoria: "Risco" },
  ],
};

describe("catálogo de categorias do funil (#4437)", () => {
  it("funil que nunca declarou abre com as cinco de FÁBRICA", () => {
    expect(categoriasDeclaradasDoFunil({})).toBeNull();
    expect(categoriasDoFunil({})).toEqual([...CATEGORIAS_DE_PERDA]);
    expect(categoriasEditaveisDoFunil({})).toEqual([...CATEGORIAS_DE_PERDA]);
    // Sem settings nenhum também: a tela não pode abrir sem categoria.
    expect(categoriasDoFunil(null)).toEqual([...CATEGORIAS_DE_PERDA]);
    expect(categoriasEditaveisDoFunil(undefined)).toEqual([...CATEGORIAS_DE_PERDA]);
  });

  it("a categoria fora da fábrica, JÁ EM USO, entra na lista — o caso «Risco»", () => {
    expect(categoriasUsadasPelosMotivos(FUNIL_DA_ISSUE)).toEqual(["Risco"]);
    expect(categoriasDoFunil(FUNIL_DA_ISSUE)).toEqual([...CATEGORIAS_DE_PERDA, "Risco"]);
    // A tela edita esse mesmo catálogo na primeira abertura: é o primeiro save
    // que grava o "Risco" na lista do funil, sem tocar no motivo.
    expect(categoriasEditaveisDoFunil(FUNIL_DA_ISSUE)).toEqual([
      ...CATEGORIAS_DE_PERDA,
      "Risco",
    ]);
  });

  it("lista declarada manda, na ordem declarada, e não vira fábrica", () => {
    const settings = {
      lost_reason_categories: ["Risco", "Operacional", "Cliente"],
      lost_reasons: [{ label: "Possível fraude", categoria: "Risco" }],
    };
    expect(categoriasDeclaradasDoFunil(settings)).toEqual(["Risco", "Operacional", "Cliente"]);
    expect(categoriasEditaveisDoFunil(settings)).toEqual(["Risco", "Operacional", "Cliente"]);
    expect(categoriasDoFunil(settings)).toEqual(["Risco", "Operacional", "Cliente"]);
  });

  it("esconder é NÃO estar na lista declarada — e a categoria em uso não some do catálogo", () => {
    // "Mérito" foi escondida, mas um motivo ainda é "Mérito".
    const settings = {
      lost_reason_categories: ["Cliente", "Risco"],
      lost_reasons: [
        { label: "Sem perfil", categoria: "Mérito" },
        { label: "Possível fraude", categoria: "Risco" },
      ],
    };
    // A tela NÃO reoferece a escondida (senão esconder não esconderia nada)...
    expect(categoriasEditaveisDoFunil(settings)).toEqual(["Cliente", "Risco"]);
    // ...mas o filtro e o relatório continuam alcançando quem já é "Mérito".
    expect(categoriasDoFunil(settings)).toEqual(["Cliente", "Risco", "Mérito"]);
  });

  it("`[]` é decisão da organização, não «nunca declarou»: a fábrica não ressuscita", () => {
    expect(categoriasDeclaradasDoFunil({ lost_reason_categories: [] })).toEqual([]);
    expect(categoriasEditaveisDoFunil({ lost_reason_categories: [] })).toEqual([]);
    expect(categoriasDoFunil({ lost_reason_categories: [] })).toEqual([]);
    // Com motivo em uso ainda sobra o que agrupar — mas só isso.
    expect(
      categoriasDoFunil({
        lost_reason_categories: [],
        lost_reasons: [{ label: "Possível fraude", categoria: "Risco" }],
      }),
    ).toEqual(["Risco"]);
  });

  it("item sujo derruba só ele: cadastro à mão não devolve o funil ao padrão", () => {
    const settings = {
      lost_reason_categories: ["Risco", "   ", 42, "x".repeat(41), "Risco", " Operacional "],
    };
    expect(categoriasDeclaradasDoFunil(settings)).toEqual(["Risco", "Operacional"]);
  });

  it("teto: no máximo 30 categorias, na ordem em que vieram", () => {
    const muitas = Array.from({ length: 35 }, (_, i) => `Categoria ${i}`);
    expect(categoriasDeclaradasDoFunil({ lost_reason_categories: muitas })).toHaveLength(30);
    expect(categoriasDeclaradasDoFunil({ lost_reason_categories: muitas })?.[0]).toBe("Categoria 0");
  });
});

describe("renomear o motivo carrega a categoria (#4437)", () => {
  const categorias = {
    "Possível fraude": "Risco",
    "É fornecedor": "Operacional",
    Price: "Nós",
  };

  it("a chave é a POSIÇÃO, não o texto: renomear mantém a categoria", () => {
    expect(
      categoriasQueSobrevivemAoTexto(
        ["Possível fraude", "É fornecedor", "Price"],
        ["Fraude confirmada", "É fornecedor", "Price"],
        categorias,
      ),
    ).toEqual({ "Fraude confirmada": "Risco", "É fornecedor": "Operacional", Price: "Nós" });
  });

  it("digitar letra a letra também mantém — cada tecla é um diff 1:1", () => {
    // O mapa é anotado como `Record<string, string>` de propósito: o retorno de
    // `categoriasQueSobrevivemAoTexto` é um record de strings, e deixar o tipo
    // ser inferido do literal (`{ "Possível fraude": string }`) exigiria essa
    // chave em TODA atribuição — o `tsc` do CI reprovava em TS2741 (run do head
    // 355fb3c516, verify-parte (1)). A chave é o rótulo que o funil usa
    // ("Possível fraude", ver `FUNIL_DA_ISSUE`); a categoria é a mesma do
    // vínculo gravado à mão.
    let atual: Record<string, string> = { "Possível fraude": "Risco" };
    let rotulos = ["Possível fraude"];
    for (const passo of ["Possível fraud", "Possível fraude r", "Possível fraude re", "Risco alto"]) {
      const proximos = [passo];
      atual = categoriasQueSobrevivemAoTexto(rotulos, proximos, atual);
      rotulos = proximos;
    }
    expect(atual).toEqual({ "Risco alto": "Risco" });
  });

  it("reordenar não é renomear: os rótulos iguais levam a categoria com eles", () => {
    expect(
      categoriasQueSobrevivemAoTexto(
        ["Possível fraude", "Price"],
        ["Price", "Possível fraude"],
        categorias,
      ),
    ).toEqual({ Price: "Nós", "Possível fraude": "Risco" });
  });

  it("motivo novo nasce sem categoria; motivo apagado leva a dele embora", () => {
    expect(
      categoriasQueSobrevivemAoTexto(
        ["Possível fraude", "Price"],
        ["Possível fraude", "Price", "Sem orçamento"],
        categorias,
      ),
    ).toEqual({ "Possível fraude": "Risco", Price: "Nós" });
    expect(
      categoriasQueSobrevivemAoTexto(["Possível fraude", "Price"], ["Price"], categorias),
    ).toEqual({ Price: "Nós" });
  });

  it("apagar um e criar outro no MESMO save não herda categoria (contagem diferente)", () => {
    expect(
      categoriasQueSobrevivemAoTexto(
        ["Possível fraude", "É fornecedor"],
        ["Sem orçamento"],
        categorias,
      ),
    ).toEqual({});
  });

  it("renomear um e criar outro no mesmo save: herda só o que tem par", () => {
    expect(
      categoriasQueSobrevivemAoTexto(
        ["Possível fraude", "Price"],
        ["Fraude confirmada", "Price", "Sem orçamento"],
        categorias,
      ),
    ).toEqual({ "Fraude confirmada": "Risco", Price: "Nós" });
  });

  it("apagar um e renomear outro no MESMO evento: a categoria vai para o renomeado", () => {
    // Colar a lista inteira na caixa apaga "Card duplicado" e renomeia o motivo
    // do "Risco" de uma vez — parear por posição daria a categoria ao motivo
    // errado; a semelhança do texto ("fraude") acha o par certo.
    expect(
      categoriasQueSobrevivemAoTexto(
        ["É fornecedor", "Card duplicado", "Possível fraude"],
        ["É fornecedor", "Fraude confirmada"],
        categorias,
      ),
    ).toEqual({ "Fraude confirmada": "Risco", "É fornecedor": "Operacional" });
  });

  it("caixa vazia zera o mapa: nada de categoria órfã sobrando", () => {
    expect(categoriasQueSobrevivemAoTexto(["Price"], [], categorias)).toEqual({});
    expect(rotulosDaCaixaDeMotivos(" , ,, ")).toEqual([]);
  });
});

describe("o rótulo do que não tem categoria (#4437)", () => {
  it("é texto explícito, não string vazia", () => {
    expect(SEM_CATEGORIA).toBe("Sem categoria");
  });
});
