import { beforeAll, describe, expect, it } from "vitest";

import { columnExists, sql } from "./gov-helpers";

/**
 * O SERVIÇO NO CATÁLOGO — as guardas do BANCO (issue #3372, fatia B).
 *
 * O teste unitário prova a régua da API (`lib/schemas/servicos.ts`). Este prova o
 * outro lado: o CHECK e o gatilho recusam mesmo quando a escrita não passa por
 * rota nenhuma — importação de planilha, script, MCP externo, psql.
 *
 * É a diferença entre "a tela não deixa" e "o banco não deixa". O critério 3 da
 * issue pede a segunda.
 *
 * Rodado por `pnpm test:db` (`scripts/test-db.sh`): baseline aplicado em modo
 * install e update, cada arquivo num banco próprio. Escreve como `postgres`, de
 * propósito — RLS é de outro teste; aqui o que se mede é constraint e gatilho.
 */

const ORG_A = "dddddddd-0000-4000-8000-000000000001";
const ORG_B = "dddddddd-0000-4000-8000-000000000002";
const SERVICO_A = "dddddddd-1111-4000-8000-000000000001";
const PRODUTO_A = "dddddddd-1111-4000-8000-000000000002";
const SERVICO_B = "dddddddd-1111-4000-8000-000000000003";

/** O erro que o banco devolveu, ou `""` quando o comando passou. */
function erroDoBanco(script: string): string {
  try {
    sql(script);
    return "";
  } catch (erro) {
    const stderr = (erro as { stderr?: string }).stderr;
    return String(stderr ?? erro);
  }
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values
        ('${ORG_A}', 'servico-a', 'Serviço A', 'Serviço A'),
        ('${ORG_B}', 'servico-b', 'Serviço B', 'Serviço B')
      on conflict do nothing;

    -- Um serviço válido, de plano recorrente por mês, com sinal de 30%.
    insert into public.catalog_products
      (id, organization_id, codigo, nome, preco_cents, moeda, controla_estoque, quantidade,
       tipo_servico, unidade_cobranca, sinal_tipo, sinal_percentual, instrucoes_ia)
      values
        ('${SERVICO_A}', '${ORG_A}', 'SOCIAL', 'Social media', 120000, 'BRL', false, 0,
         'recorrente', 'mes', 'percentual', 30, 'Nunca prometer prazo menor que 30 dias.'),
        ('${SERVICO_B}', '${ORG_B}', 'SOCIAL', 'Social media', 120000, 'BRL', false, 0,
         'recorrente', 'mes', null, null, null)
      on conflict do nothing;

    -- Um produto de prateleira, que é o que toda instalação já tem.
    insert into public.catalog_products
      (id, organization_id, codigo, nome, preco_cents, moeda)
      values ('${PRODUTO_A}', '${ORG_A}', 'CAMISETA', 'Camiseta', 5000, 'BRL')
      on conflict do nothing;
  `);
});

describe("as colunas de serviço existem", () => {
  it("tipo, unidade, prazo, sinal, instruções, pai e revisão", () => {
    for (const coluna of [
      "tipo_servico",
      "unidade_cobranca",
      "prazo_dias_uteis",
      "sinal_tipo",
      "sinal_percentual",
      "sinal_cents",
      "instrucoes_ia",
      "ia_oferece",
      "ia_agenda",
      "pai_id",
      "revision",
    ]) {
      expect(columnExists("catalog_products", coluna)).toBe(true);
    }
  });

  it("produto de prateleira continua sem tipo, e a IA não agenda o que não é serviço", () => {
    const linha = sql(`
      select tipo_servico is null, unidade_cobranca is null, ia_oferece, ia_agenda
      from public.catalog_products where id = '${PRODUTO_A}';
    `);
    expect(linha).toBe("t|t|t|f");
  });
});

describe("unidade de cobrança × tipo", () => {
  it("recusa plano recorrente cobrado por hora", () => {
    // Contrato diferente, não vocabulário: quem cobra por hora cadastra
    // hora marcada ou projeto por hora.
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca)
        values ('${ORG_A}', 'ERRO-1', 'Erro unidade', 1000, false, 0, 'recorrente', 'hora');
    `);
    expect(erro).toContain("catalog_products_servico_unidade_check");
  });

  it("recusa serviço sem unidade e unidade sem tipo", () => {
    const semUnidade = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico)
        values ('${ORG_A}', 'ERRO-2', 'Erro sem unidade', 1000, false, 0, 'projeto');
    `);
    expect(semUnidade).toContain("catalog_products_servico_unidade_check");

    const semTipo = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, unidade_cobranca)
        values ('${ORG_A}', 'ERRO-3', 'Erro sem tipo', 1000, false, 0, 'mes');
    `);
    expect(semTipo).toContain("catalog_products_servico_unidade_check");
  });

  it("recusa tipo que não existe (a régua de unidade cobre) e preço negativo", () => {
    // O tipo desconhecido não casa nenhuma família de unidade, então quem recusa
    // primeiro é `servico_unidade_check` — o `tipo_servico_check` é a guarda
    // final, alcançada só por quem chegar com tipo inválido e sem unidade.
    const tipoInvalido = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca)
        values ('${ORG_A}', 'ERRO-4', 'Erro tipo', 1000, false, 0, 'assinatura', 'mes');
    `);
    expect(tipoInvalido).toContain("catalog_products_servico_unidade_check");

    const precoNegativo = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca)
        values ('${ORG_A}', 'ERRO-5', 'Erro preço', -1, false, 0, 'recorrente', 'mes');
    `);
    expect(precoNegativo).toContain("catalog_products_preco_nao_negativo");
  });
});

describe("prazo em dias úteis", () => {
  it("só existe em projeto", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca, prazo_dias_uteis)
        values ('${ORG_A}', 'ERRO-6', 'Erro prazo', 1000, false, 0, 'hora_marcada', 'sessao', 10);
    `);
    expect(erro).toContain("catalog_products_servico_prazo_check");
  });

  it("aceita prazo em projeto", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca, prazo_dias_uteis)
        values ('${ORG_A}', 'SITE', 'Site institucional', 450000, false, 0, 'projeto', 'valor_fechado', 30);
    `);
    expect(erro).toBe("");
  });
});

describe("sinal", () => {
  it("percentual fora de 1 a 100 é recusado", () => {
    for (const percentual of ["0", "101"]) {
      const erro = erroDoBanco(`
        insert into public.catalog_products
          (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca, sinal_tipo, sinal_percentual)
          values ('${ORG_A}', 'ERRO-S${percentual}', 'Erro sinal', 1000, false, 0, 'recorrente', 'mes', 'percentual', ${percentual});
      `);
      expect(erro).toContain("catalog_products_servico_sinal_check");
    }
  });

  it("percentual E fixo ao mesmo tempo é recusado", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca, sinal_tipo, sinal_percentual, sinal_cents)
        values ('${ORG_A}', 'ERRO-S2', 'Erro sinal duplo', 1000, false, 0, 'recorrente', 'mes', 'fixo', 30, 500);
    `);
    expect(erro).toContain("catalog_products_servico_sinal_check");
  });

  it("sinal fixo zero é recusado", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca, sinal_tipo, sinal_cents)
        values ('${ORG_A}', 'ERRO-S3', 'Erro sinal zero', 1000, false, 0, 'recorrente', 'mes', 'fixo', 0);
    `);
    expect(erro).toContain("catalog_products_servico_sinal_check");
  });

  it("produto de prateleira não carrega sinal", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, sinal_tipo, sinal_percentual)
        values ('${ORG_A}', 'ERRO-S4', 'Produto com sinal', 1000, 'percentual', 30);
    `);
    expect(erro).toContain("catalog_products_servico_sinal_check");
  });
});

describe("serviço nunca controla estoque (#2497)", () => {
  it("recusa serviço com controla_estoque ligado", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca)
        values ('${ORG_A}', 'ERRO-E1', 'Serviço com estoque', 1000, true, 0, 'recorrente', 'mes');
    `);
    expect(erro).toContain("catalog_products_servico_sem_estoque_check");
  });

  it("recusa serviço com quantidade", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca)
        values ('${ORG_A}', 'ERRO-E2', 'Serviço com quantidade', 1000, false, 3, 'recorrente', 'mes');
    `);
    expect(erro).toContain("catalog_products_servico_sem_estoque_check");
  });
});

describe("variação = item do catálogo ligado ao principal", () => {
  it("aceita variação com nome, código e preço próprios", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, pai_id)
        values ('${ORG_A}', 'SOCIAL-20', 'Social media 20 posts + 4 reels', 190000, false, 0, '${SERVICO_A}');
    `);
    expect(erro).toBe("");
  });

  it("recusa variação carregando tipo (o principal é quem diz de que tipo é)", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca, pai_id)
        values ('${ORG_A}', 'ERRO-V1', 'Variação com tipo', 190000, false, 0, 'recorrente', 'mes', '${SERVICO_A}');
    `);
    expect(erro).toContain("catalog_products_servico_variacao_check");
  });

  it("recusa variação de um produto que não é serviço", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, pai_id)
        values ('${ORG_A}', 'ERRO-V2', 'Variação de camiseta', 6000, false, 0, '${PRODUTO_A}');
    `);
    expect(erro).toContain("pai_nao_e_servico");
  });

  it("recusa variação de serviço de OUTRA organização", () => {
    // Sem o gatilho, o `pai_id` atravessaria o tenant: a variação apareceria no
    // serviço do vizinho para quem lê as duas organizações.
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, pai_id)
        values ('${ORG_B}', 'ERRO-V3', 'Variação atravessada', 190000, false, 0, '${SERVICO_A}');
    `);
    expect(erro).toContain("variacao_de_outra_organizacao");
  });

  it("recusa variação de variação", () => {
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, pai_id)
        values ('${ORG_A}', 'ERRO-V4', 'Variação da variação', 200000, false, 0,
                (select id from public.catalog_products where organization_id = '${ORG_A}' and codigo = 'SOCIAL-20'));
    `);
    expect(erro).toContain("variacao_nao_tem_variacao");
  });

  it("recusa variação de si mesma", () => {
    // Por UPDATE, e não por INSERT: no insert o id ainda não existe e o gatilho
    // responderia "pai inexistente" — a guarda de ciclo só tem o que medir numa
    // linha que já está gravada.
    const erro = erroDoBanco(`
      insert into public.catalog_products
        (id, organization_id, codigo, nome, preco_cents, controla_estoque, quantidade, tipo_servico, unidade_cobranca)
        values ('dddddddd-1111-4000-8000-0000000000ff', '${ORG_A}', 'ERRO-V5', 'Eu mesmo', 1000, false, 0,
                'recorrente', 'mes')
        on conflict do nothing;
      update public.catalog_products set pai_id = id
        where id = 'dddddddd-1111-4000-8000-0000000000ff';
    `);
    expect(erro).toContain("catalog_products_pai_nao_e_ele_mesmo_check");
  });
});

describe("revisão", () => {
  it("nasce em 1 e só cresce a cada escrita", () => {
    const antes = sql(`select revision from public.catalog_products where id = '${SERVICO_A}';`);
    expect(antes).toBe("1");

    sql(`update public.catalog_products set nome = nome where id = '${SERVICO_A}';`);
    const depois = sql(`select revision from public.catalog_products where id = '${SERVICO_A}';`);
    expect(Number(depois)).toBe(Number(antes) + 1);
  });
});
