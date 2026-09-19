/**
 * O que cada entidade do catálogo financeiro aceita — e o que recusa.
 *
 * Os dois casos que importam são recusas, e as duas vêm de defeitos MEDIDOS no
 * sistema de origem:
 *
 * 1. plano de contas sem direção. Lá, as 17 linhas eram todas `debito` —
 *    inclusive "Serviços" e "Comissão", que são coisas opostas. Um campo que
 *    existe e não distingue nada é pior que campo nenhum, porque dá a impressão
 *    de que alguém classificou.
 * 2. saldo inicial negativo PERMITIDO. Parece erro e não é: conta pode começar
 *    negativa (cheque especial, fatura aberta), e recusar obrigaria quem tem a
 *    mentir no cadastro.
 */
import { describe, expect, it } from "vitest";

import {
  contaSchema,
  ehEntidadeDoCatalogo,
  formaDePagamentoSchema,
  planoDeContaSchema,
  SCHEMA_POR_ENTIDADE,
  COLUNAS_POR_ENTIDADE,
  ENTIDADES_DO_CATALOGO,
} from "./catalogo";

describe("conta", () => {
  it("nasce em caixa e BRL quando não se diz nada", () => {
    const r = contaSchema.parse({ name: "Caixa" });
    expect(r).toMatchObject({ kind: "cash", currency: "BRL", opening_balance_cents: 0 });
  });

  it("aceita saldo inicial NEGATIVO — e isso é deliberado", () => {
    // Cheque especial e fatura aberta existem. Recusar obrigaria a mentir.
    expect(contaSchema.parse({ name: "Banco", opening_balance_cents: -150000 })
      .opening_balance_cents).toBe(-150000);
  });

  it("recusa tipo de conta inventado", () => {
    expect(contaSchema.safeParse({ name: "X", kind: "cripto" }).success).toBe(false);
  });

  it("recusa nome de uma letra", () => {
    expect(contaSchema.safeParse({ name: "C" }).success).toBe(false);
  });
});

describe("forma de pagamento", () => {
  it("pode nascer SEM conta — o catálogo se monta antes de o banco abrir", () => {
    // Recusar aqui impediria cadastrar "Pix" antes de decidir onde ele cai. A
    // checagem que importa é a da FINALIZAÇÃO da comanda, não a do cadastro.
    expect(formaDePagamentoSchema.safeParse({ name: "Pix" }).success).toBe(true);
    expect(formaDePagamentoSchema.safeParse({ name: "Pix", account_id: null }).success).toBe(true);
  });

  it("recusa conta que não é uuid", () => {
    expect(formaDePagamentoSchema.safeParse({ name: "Pix", account_id: "a-conta" }).success).toBe(
      false,
    );
  });
});

describe("plano de contas", () => {
  it("EXIGE direção — sem default", () => {
    // O sistema de origem tinha as 17 linhas como 'debito', inclusive
    // "Serviços" e "Comissão". Um default aqui reproduziria isso, porque quem
    // cadastra depressa aceita o que vem.
    expect(planoDeContaSchema.safeParse({ name: "Serviços" }).success).toBe(false);
    expect(planoDeContaSchema.safeParse({ name: "Serviços", direction: "in" }).success).toBe(true);
    expect(planoDeContaSchema.safeParse({ name: "Comissão", direction: "out" }).success).toBe(true);
  });

  it("recusa direção fora do vocabulário", () => {
    expect(planoDeContaSchema.safeParse({ name: "X", direction: "debito" }).success).toBe(false);
  });
});

describe("o mapa de entidades", () => {
  it("toda entidade tem schema, colunas e tabela", () => {
    for (const chave of Object.keys(ENTIDADES_DO_CATALOGO)) {
      const k = chave as keyof typeof ENTIDADES_DO_CATALOGO;
      expect(SCHEMA_POR_ENTIDADE[k], chave).toBeTruthy();
      expect(COLUNAS_POR_ENTIDADE[k], chave).toContain("id");
      expect(COLUNAS_POR_ENTIDADE[k], chave).toContain("is_active");
    }
  });

  it("o guarda do path recusa nome de tabela cru", () => {
    // O path aceita `contas`, nunca `financial_accounts`: vocabulário de banco
    // na URL vaza o schema e amarra a API à tabela.
    expect(ehEntidadeDoCatalogo("contas")).toBe(true);
    expect(ehEntidadeDoCatalogo("financial_accounts")).toBe(false);
    expect(ehEntidadeDoCatalogo("../../etc")).toBe(false);
  });
});
