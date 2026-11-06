import { describe, expect, it } from "vitest";

import {
  ORIGEM_DO_FEED,
  planejarRodadaDoFeed,
  type MapeamentoDoFeed,
  type ProdutoExistente,
} from "./feed";

/**
 * O PLANO DA RODADA DO FEED — puro, sem banco e sem rede.
 *
 * O que estes casos prendem é a REGRA que faz a sincronização ser sincronização
 * e não uma segunda importação: o id externo é a identidade (repetido no feed
 * não duplica; ausente não some com a rodada), o que saiu vira `desativar` em
 * vez de `DELETE`, e rodar o MESMO feed duas vezes não muda nada na segunda.
 */

const MAPEAMENTO: MapeamentoDoFeed = {
  id_externo: "sku",
  nome: "titulo",
  preco: "preco",
  descricao: "descricao",
  fotos: "fotos",
};

/** Um produto que já está no catálogo. `origem: feed` marca o que o feed possui. */
function existente(over: Partial<ProdutoExistente> & { codigo: string }): ProdutoExistente {
  return {
    id: `id-${over.codigo}`,
    nome: `Produto ${over.codigo}`,
    descricao: null,
    preco_cents: 1000,
    marca: null,
    categoria: null,
    quantidade: null,
    fotos: null,
    ativo: true,
    origem: ORIGEM_DO_FEED,
    ...over,
  };
}

function plano(entrada: Parameters<typeof planejarRodadaDoFeed>[0]) {
  const resultado = planejarRodadaDoFeed(entrada);
  if (!resultado.ok) throw new Error(`plano recusado: ${resultado.erro}`);
  return resultado.plano;
}

describe("planejarRodadaDoFeed — cria, atualiza e desativa pelo id externo", () => {
  it("3 itens: 1 já existe com preço novo, 1 é novo, 1 sumiu do feed", () => {
    const p = plano({
      formato: "json",
      itens: [
        { sku: "A", titulo: "Produto A", preco: 12.5, descricao: null, fotos: [] },
        { sku: "C", titulo: "Produto C", preco: 30, descricao: null, fotos: [] },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [
        existente({ codigo: "A", nome: "Produto A", preco_cents: 1000 }),
        existente({ codigo: "B", nome: "Produto B" }),
      ],
    });

    expect({
      criar: p.contagem.criar,
      atualizar: p.contagem.atualizar,
      desativar: p.contagem.desativar,
      inalterados: p.contagem.inalterados,
    }).toEqual({ criar: 1, atualizar: 1, desativar: 1, inalterados: 0 });

    // O id externo é a chave: A casa com o produto existente, C é novo.
    expect(p.atualizar[0]!.produto.id_externo).toBe("A");
    expect(p.atualizar[0]!.produto_id).toBe("id-A");
    expect(p.atualizar[0]!.produto.preco_cents).toBe(1250);
    expect(p.atualizar[0]!.mudancas).toContain("preco_cents");
    expect(p.criar[0]!.produto.id_externo).toBe("C");
    expect(p.criar[0]!.produto_id).toBeNull();
    // O que saiu NÃO é apagado: entra como desativação, com a linha existente.
    expect(p.desativar[0]!.produto.id_externo).toBe("B");
    expect(p.desativar[0]!.produto_id).toBe("id-B");
  });

  it("o MESMO feed rodado de novo não cria, não atualiza e não desativa nada", () => {
    // O estado DEPOIS da primeira rodada: A com o preço novo, C criado e B
    // desativado — é exatamente o que o servidor teria gravado.
    const depoisDaPrimeira: ProdutoExistente[] = [
      existente({ codigo: "A", nome: "Produto A", preco_cents: 1250, descricao: null, fotos: [] }),
      existente({ codigo: "C", nome: "Produto C", preco_cents: 3000, descricao: null, fotos: [] }),
      existente({ codigo: "B", nome: "Produto B", ativo: false }),
    ];

    const p = plano({
      formato: "json",
      itens: [
        { sku: "A", titulo: "Produto A", preco: 12.5, descricao: null, fotos: [] },
        { sku: "C", titulo: "Produto C", preco: 30, descricao: null, fotos: [] },
      ],
      mapeamento: MAPEAMENTO,
      existentes: depoisDaPrimeira,
    });

    expect({
      criar: p.contagem.criar,
      atualizar: p.contagem.atualizar,
      desativar: p.contagem.desativar,
    }).toEqual({ criar: 0, atualizar: 0, desativar: 0 });
    expect(p.contagem.inalterados).toBe(2);
    expect(p.errosPorItem).toEqual([]);
  });

  it("id externo repetido no feed: o primeiro vale, o segundo vira erro — não duplica", () => {
    const p = plano({
      formato: "json",
      itens: [
        { sku: "A", titulo: "Produto A", preco: 10 },
        { sku: "A", titulo: "Produto A (repetido)", preco: 20 },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(1);
    expect(p.criar[0]!.produto.nome).toBe("Produto A");
    expect(p.errosPorItem).toHaveLength(1);
    expect(p.errosPorItem[0]!.linha).toBe(2);
    expect(p.errosPorItem[0]!.id_externo).toBe("A");
    expect(p.errosPorItem[0]!.motivo).toContain("repetido");
  });

  it("item sem id externo não aborta a rodada: ele vira erro e os outros entram", () => {
    const p = plano({
      formato: "json",
      itens: [
        { sku: "", titulo: "Sem id", preco: 10 },
        { sku: "B", titulo: "Produto B", preco: 20 },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(1);
    expect(p.criar[0]!.produto.id_externo).toBe("B");
    expect(p.errosPorItem).toHaveLength(1);
    expect(p.errosPorItem[0]!.linha).toBe(1);
    expect(p.errosPorItem[0]!.motivo).toContain("id externo");
  });

  it("id externo em OUTRA caixa já cadastrado é recusado, e a rodada segue", () => {
    const p = plano({
      formato: "json",
      itens: [
        { sku: "ip15", titulo: "iPhone 15", preco: 5499 },
        { sku: "X", titulo: "Outro", preco: 10 },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [existente({ codigo: "IP15", nome: "iPhone 15" })],
    });

    expect(p.contagem.criar).toBe(1);
    expect(p.errosPorItem).toHaveLength(1);
    expect(p.errosPorItem[0]!.motivo).toContain("outra caixa");
  });

  it("produto de outra origem NÃO é desativado por não estar no feed", () => {
    const p = plano({
      formato: "json",
      itens: [{ sku: "A", titulo: "Produto A", preco: 10 }],
      mapeamento: MAPEAMENTO,
      existentes: [
        existente({ codigo: "A", nome: "Produto A" }),
        existente({ codigo: "MANUAL", nome: "Cadastrado na tela", origem: "manual" }),
        existente({ codigo: "PLAN", nome: "Veio da planilha", origem: "planilha" }),
      ],
    });

    expect(p.contagem.desativar).toBe(0);
  });

  it("desativar_ausentes: false preserva o que sumiu do feed", () => {
    const p = plano({
      formato: "json",
      itens: [{ sku: "A", titulo: "Produto A", preco: 10 }],
      mapeamento: MAPEAMENTO,
      existentes: [existente({ codigo: "A", nome: "Produto A" }), existente({ codigo: "B" })],
      desativarAusentes: false,
    });

    expect(p.contagem.desativar).toBe(0);
  });

  it("o MESMO feed com a mesma foto (mesma quantidade) é inalterado", () => {
    const fotos = ["https://cdn.loja/1.jpg", "https://cdn.loja/2.jpg"];
    const p = plano({
      formato: "json",
      itens: [{ sku: "A", titulo: "Produto A", preco: 10, fotos }],
      mapeamento: MAPEAMENTO,
      existentes: [
        // No catálogo as fotos são CAMINHOS do bucket, não as URLs do feed: a
        // comparação possível é a quantidade, na ordem.
        existente({ codigo: "A", nome: "Produto A", fotos: ["org/a/1.jpg", "org/a/2.jpg"] }),
      ],
    });

    expect(p.contagem.inalterados).toBe(1);
    expect(p.contagem.atualizar).toBe(0);
  });

  it("foto a mais no feed entra como atualização", () => {
    const p = plano({
      formato: "json",
      itens: [
        {
          sku: "A",
          titulo: "Produto A",
          preco: 10,
          fotos: ["https://cdn.loja/1.jpg", "https://cdn.loja/2.jpg"],
        },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [existente({ codigo: "A", nome: "Produto A", fotos: ["org/a/1.jpg"] })],
    });

    expect(p.contagem.atualizar).toBe(1);
    expect(p.atualizar[0]!.mudancas).toContain("fotos");
  });
});

describe("planejarRodadaDoFeed — normalização de valor", () => {
  it("preço: número em reais vira centavos; string pt-BR também", () => {
    const p = plano({
      formato: "json",
      itens: [
        { sku: "A", titulo: "A", preco: 5499.9 },
        { sku: "B", titulo: "B", preco: "R$ 5.499,00" },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.criar.map((i) => i.produto.preco_cents)).toEqual([549990, 549900]);
  });

  it("preco_em_centavos: true lê o número como centavos", () => {
    const p = plano({
      formato: "json",
      itens: [{ sku: "A", titulo: "A", preco: 549900 }],
      mapeamento: { ...MAPEAMENTO, preco_em_centavos: true },
      existentes: [],
    });

    expect(p.criar[0]!.produto.preco_cents).toBe(549900);
  });

  it("preço ilegível vira erro do item, não preço chutado", () => {
    const p = plano({
      formato: "json",
      itens: [
        { sku: "A", titulo: "A", preco: "a combinar" },
        { sku: "B", titulo: "B", preco: 10 },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(1);
    expect(p.errosPorItem[0]!.motivo).toContain("preço");
  });

  it("mais fotos que o teto é recusado inteiro, sem cortar em silêncio", () => {
    const p = plano({
      formato: "json",
      itens: [
        {
          sku: "A",
          titulo: "A",
          preco: 10,
          fotos: Array.from({ length: 6 }, (_, i) => `https://cdn.loja/${i}.jpg`),
        },
      ],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(0);
    expect(p.errosPorItem[0]!.motivo).toContain("5");
  });

  it("foto que não é http(s) é recusada no plano", () => {
    const p = plano({
      formato: "json",
      itens: [{ sku: "A", titulo: "A", preco: 10, fotos: ["file:///etc/passwd"] }],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(0);
    expect(p.errosPorItem[0]!.motivo).toContain("http");
  });

  it("CSV: cabeçalho mapeado, foto separada por `|` na ordem da capa", () => {
    const p = plano({
      formato: "csv",
      conteudo:
        "sku;titulo;preco;descricao;fotos\n" +
        "A;Produto A;R$ 10,00;;https://cdn.loja/1.jpg|https://cdn.loja/2.jpg\n" +
        "B;Produto B;20,00;Descrição B;\n",
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(2);
    expect(p.criar[0]!.produto.fotos).toEqual(["https://cdn.loja/1.jpg", "https://cdn.loja/2.jpg"]);
    expect(p.criar[0]!.produto.preco_cents).toBe(1000);
    expect(p.criar[1]!.produto.descricao).toBe("Descrição B");
  });

  it("CSV sem a coluna do id externo é recusa do ARQUIVO, não 300 erros iguais", () => {
    const resultado = planejarRodadaDoFeed({
      formato: "csv",
      conteudo: "titulo;preco\nProduto A;10\n",
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erro).toContain("sku");
  });

  it("item que não é objeto no JSON vira erro daquela linha", () => {
    const p = plano({
      formato: "json",
      itens: ["texto solto", { sku: "A", titulo: "A", preco: 10 }],
      mapeamento: MAPEAMENTO,
      existentes: [],
    });

    expect(p.contagem.criar).toBe(1);
    expect(p.errosPorItem[0]!.linha).toBe(1);
  });
});
