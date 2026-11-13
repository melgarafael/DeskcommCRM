import { describe, expect, it } from "vitest";

import {
  type ProdutoDoCatalogo,
  planejarFeed,
  resumoDoPlano,
} from "@/lib/catalogo/feed";

/**
 * O FEED DA REVENDA VIRA PLANO DE RODADA — sem banco, sem rede, sem tela.
 *
 * ─── O que este arquivo existe para impedir ─────────────────────────────────
 *
 * O catálogo é o que o agente de IA responde ao cliente. Duas coisas dão errado
 * em silêncio quando a sincronização é feita "na mão" a cada rodada:
 *
 *  - o MESMO produto entra duas vezes (id externo repetido no feed, ou casamento
 *    por nome) e o agente passa a ter dois preços para o mesmo item;
 *  - o item que saiu do estoque CONTINUA ativo, e o agente vende o que a loja
 *    não tem mais.
 *
 * Por isso o id externo é a CHAVE, e o que sumiu do feed é DESATIVADO — nunca
 * apagado: histórico de conversa e proposta apontam para a linha do produto.
 *
 * ─── Por que o teste é puro ─────────────────────────────────────────────────
 *
 * A regra é comparação de valores (preço em centavos, fotos na ordem). Ela não
 * depende de PostgREST para ser verdadeira, e um teste que precisasse de banco
 * não rodaria em todo `pnpm test`. Quem prova a escrita é a rota, com cliente
 * de mentira (`app/api/v1/products/feed/route.test.ts`).
 */

const FOTOS = [
  "https://cdn.revenda.example/fone-1.jpg",
  "https://cdn.revenda.example/fone-2.jpg",
];

const existente = (over: Partial<ProdutoDoCatalogo> = {}): ProdutoDoCatalogo => ({
  id: "p-existente",
  id_externo: "SKU-1",
  nome: "Fone Bluetooth",
  descricao: "Fone de ouvido sem fio",
  preco_cents: 100_000,
  fotos: null,
  quantidade: 0,
  ativo: true,
  ...over,
});

const feedDe = (itens: unknown[]): string => JSON.stringify(itens);

describe("planejarFeed: o plano da rodada", () => {
  it("cria o novo, atualiza o que mudou e desativa o que saiu do feed", () => {
    const feed = feedDe([
      // Já existe, com preço novo.
      { id: "SKU-1", nome: "Fone Bluetooth", preco: "1.200,00", descricao: "Fone de ouvido sem fio" },
      // Não existe ainda.
      { id: "SKU-2", nome: "Carregador turbo", preco: 89.9 },
    ]);

    const resultado = planejarFeed({
      conteudo: feed,
      formato: "json",
      existentes: [
        existente(),
        // Sumiu do feed: continua na tabela, mas desativado.
        existente({ id: "p-sumiu", id_externo: "SKU-9", nome: "Capa antiga" }),
      ],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resumoDoPlano(resultado.plano)).toMatchObject({
      criar: 1,
      atualizar: 1,
      desativar: 1,
      inalterados: 0,
      erros: 0,
    });
    expect(resultado.plano.criar[0]).toMatchObject({ id_externo: "SKU-2", preco_cents: 8_990 });
    expect(resultado.plano.atualizar[0]).toMatchObject({ id: "p-existente", id_externo: "SKU-1" });
    expect(resultado.plano.atualizar[0]!.campos.preco_cents).toBe(120_000);
    // Desativar carrega o ID da LINHA — não há DELETE em lugar nenhum do plano.
    expect(resultado.plano.desativar[0]).toMatchObject({ id: "p-sumiu", id_externo: "SKU-9" });
  });

  it("rodar de novo com o MESMO feed não cria, não atualiza e não desativa nada", () => {
    const feed = feedDe([
      { id: "SKU-1", nome: "Fone Bluetooth", preco: "1.200,00", descricao: "Fone de ouvido sem fio" },
      { id: "SKU-2", nome: "Carregador turbo", preco: 89.9 },
    ]);

    // O estado DEPOIS da rodada anterior: o preço já é o do feed, o novo já
    // existe e o que saiu já está desativado.
    const resultado = planejarFeed({
      conteudo: feed,
      formato: "json",
      existentes: [
        existente({ preco_cents: 120_000 }),
        existente({ id: "p-novo", id_externo: "SKU-2", nome: "Carregador turbo", preco_cents: 8_990 }),
        existente({ id: "p-sumiu", id_externo: "SKU-9", nome: "Capa antiga", ativo: false }),
      ],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resumoDoPlano(resultado.plano)).toMatchObject({
      criar: 0,
      atualizar: 0,
      desativar: 0,
      erros: 0,
    });
  });

  it("id externo repetido no feed: um entra, o outro vira erro — não duplica", () => {
    const resultado = planejarFeed({
      conteudo: feedDe([
        { id: "SKU-7", nome: "Película", preco: 19.9 },
        { id: "sku-7 ", nome: "Película (repetida)", preco: 29.9 },
      ]),
      formato: "json",
      existentes: [],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.plano.criar).toHaveLength(1);
    expect(resultado.plano.criar[0]).toMatchObject({ id_externo: "SKU-7", preco_cents: 1_990 });
    expect(resultado.plano.errosPorItem).toHaveLength(1);
    expect(resultado.plano.errosPorItem[0]!.motivo).toContain("repetido");
  });

  it("item sem id externo vira erro e a rodada NÃO aborta", () => {
    const resultado = planejarFeed({
      conteudo: feedDe([
        { nome: "Item sem código", preco: 10 },
        { id: "SKU-3", nome: "Cabo USB-C", preco: 25 },
      ]),
      formato: "json",
      existentes: [],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.plano.criar).toHaveLength(1);
    expect(resultado.plano.criar[0]!.id_externo).toBe("SKU-3");
    expect(resultado.plano.errosPorItem).toHaveLength(1);
    expect(resultado.plano.errosPorItem[0]!.motivo).toContain("id externo");
  });

  it("o produto que deu erro no feed NÃO é desativado — ele ainda está no feed", () => {
    const resultado = planejarFeed({
      conteudo: feedDe([{ id: "SKU-1", nome: "Fone Bluetooth", preco: "incompreensível" }]),
      formato: "json",
      existentes: [existente()],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.plano.errosPorItem).toHaveLength(1);
    expect(resultado.plano.desativar).toHaveLength(0);
  });

  it("compara as fotos NA ORDEM e preço em centavos", () => {
    const feed = feedDe([{ id: "SKU-1", nome: "Fone Bluetooth", preco: "1.000,00", fotos: FOTOS }]);

    const igual = planejarFeed({
      conteudo: feed,
      formato: "json",
      existentes: [existente({ fotos: FOTOS })],
    });
    expect(igual.ok && igual.plano.atualizar).toHaveLength(0);

    const invertida = planejarFeed({
      conteudo: feed,
      formato: "json",
      existentes: [existente({ fotos: [...FOTOS].reverse() })],
    });
    expect(invertida.ok && invertida.plano.atualizar).toHaveLength(1);
    expect(invertida.ok && invertida.plano.atualizar[0]!.mudou).toContain("fotos");
  });

  it("feed sem a coluna de foto não apaga a foto que a tela gravou", () => {
    const resultado = planejarFeed({
      conteudo: feedDe([{ id: "SKU-1", nome: "Fone Bluetooth", preco: "1.000,00" }]),
      formato: "json",
      existentes: [existente({ fotos: FOTOS })],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.plano.atualizar).toHaveLength(0);
    expect(resultado.plano.inalterados).toBe(1);
  });

  it("le CSV com o mapeamento de colunas", () => {
    const csv = [
      "codigo;nome;preco;fotos",
      "SKU-2;Carregador turbo;89,90;",
      "SKU-1;Fone Bluetooth;1.000,00;",
    ].join("\n");

    const resultado = planejarFeed({ conteudo: csv, formato: "csv", existentes: [existente()] });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resumoDoPlano(resultado.plano)).toMatchObject({ criar: 1, atualizar: 0, inalterados: 1 });
  });

  it("feed ilegível é recusa inteira, não catálogo vazio", () => {
    const resultado = planejarFeed({ conteudo: "{isto não é json", formato: "json", existentes: [] });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toContain("JSON");
  });

  it("o mesmo preço escrito de outro jeito é o MESMO preço", () => {
    const resultado = planejarFeed({
      conteudo: feedDe([{ id: "SKU-1", nome: "Fone Bluetooth", preco: "R$ 1.000,00" }]),
      formato: "json",
      existentes: [existente()],
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.plano.atualizar).toHaveLength(0);
  });
});
