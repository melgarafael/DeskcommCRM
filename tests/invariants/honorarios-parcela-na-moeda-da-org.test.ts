import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A PARCELA DE HONORÁRIOS E O CAIXA DELA FALAM A MESMA MOEDA (#3379).
 *
 * `honorarios_parcelas` nasceu com `valor_cents` e sem unidade, e
 * `fn_honorarios_parcela_pagar` lançava no `financial_entries` sem `currency` —
 * coluna que tem `default 'BRL'`. Numa organização em dólar, a parcela de
 * `1,300` aparecia `R$ 1.300,00` na tela e o pagamento dela entrava no bloco
 * BRL do relatório: dois lugares, o mesmo valor errado de unidade.
 *
 * Este arquivo mede o BANCO, e não a rota: a rota já tem gate próprio
 * (`tests/unit/financeiro-cada-escrita-na-moeda-da-org.test.ts`), e a decisão de
 * modelagem — coluna própria, em vez de herdar `organizations.currency` na
 * leitura — só se prova aqui, com o módulo PROVISIONADO:
 *
 *   1. `fn_honorarios_provisionar()` cria a coluna, com `default 'BRL'`;
 *   2. parcela gravada em USD paga um lançamento em USD (e não em BRL);
 *   3. parcela antiga, sem moeda declarada, cai no default e o caixa dela segue
 *      em BRL — o backfill declarado na migration, não uma conversão silenciosa.
 *
 * O caso 3 é o que impede o conserto de "adivinhar" a moeda de quem já pagou.
 */

const ORG_BRL = "b7b7b7b7-0000-4000-8000-000000000001";
const ORG_USD = "b7b7b7b7-0000-4000-8000-000000000002";
const GERENTE = "b7b7b7b7-1111-4000-8000-000000000001";
const CONTA_BRL = "b7b7b7b7-2222-4000-8000-000000000001";
const CONTA_USD = "b7b7b7b7-2222-4000-8000-000000000002";
const CONTRATO_BRL = "b7b7b7b7-3333-4000-8000-000000000001";
const CONTRATO_USD = "b7b7b7b7-3333-4000-8000-000000000002";
const PARCELA_USD = "b7b7b7b7-4444-4000-8000-000000000001";
const PARCELA_SEM_MOEDA = "b7b7b7b7-4444-4000-8000-000000000002";

const COMO_GERENTE = `
  set role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${GERENTE}","role":"authenticated"}', false);
`;

function pagar(org: string, parcela: string, conta: string): string {
  return `select public.fn_honorarios_parcela_pagar('${org}'::uuid, '${parcela}'::uuid, '${conta}'::uuid)::text;`;
}

/** A moeda que o lançamento do caixa daquela parcela recebeu. */
function moedaDoLancamentoDa(parcela: string): string | null {
  const linha = lastLine(
    sql(`
      select fe.currency
        from public.financial_entries fe
        join public.honorarios_parcelas p on p.financial_entry_id = fe.id
       where p.id = '${parcela}';
    `),
  );
  return linha === "" ? null : linha;
}

beforeAll(() => {
  sql(`
    select public.fn_honorarios_provisionar();

    insert into auth.users (id, email) values
      ('${GERENTE}', 'honorarios-moeda@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, currency) values
      ('${ORG_BRL}', 'honorarios-moeda-brl', 'Honorarios Moeda BRL', 'HMB', 'BRL'),
      ('${ORG_USD}', 'honorarios-moeda-usd', 'Honorarios Moeda USD', 'HMU', 'USD')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE}', '${ORG_BRL}', 'manager', now()),
      ('${GERENTE}', '${ORG_USD}', 'manager', now())
      on conflict do nothing;
    insert into public.financial_accounts (id, organization_id, name, currency) values
      ('${CONTA_BRL}', '${ORG_BRL}', 'Caixa BRL', 'BRL'),
      ('${CONTA_USD}', '${ORG_USD}', 'Caixa USD', 'USD')
      on conflict (id) do nothing;
    insert into public.honorarios_contratos (id, organization_id, modelo, valor_fixo_cents) values
      ('${CONTRATO_BRL}', '${ORG_BRL}', 'fixo', 300000),
      ('${CONTRATO_USD}', '${ORG_USD}', 'fixo', 130000)
      on conflict (id) do nothing;
  `);
});

describe("honorarios_parcelas.currency — a coluna que a parcela não tinha", () => {
  it("o provisionamento cria a coluna, com default 'BRL'", () => {
    const padrao = lastLine(
      sql(`
        select column_default
          from information_schema.columns
         where table_schema = 'public'
           and table_name = 'honorarios_parcelas'
           and column_name = 'currency';
      `),
    );
    expect(padrao).toContain("BRL");
  });

  it("a parcela grava a moeda que veio do servidor", () => {
    sql(`
      insert into public.honorarios_parcelas
        (id, organization_id, contrato_id, numero, vencimento, valor_cents, currency)
      values
        ('${PARCELA_USD}', '${ORG_USD}', '${CONTRATO_USD}', 1, '2026-11-10', 130000, 'USD')
        on conflict (id) do nothing;
    `);

    expect(
      lastLine(sql(`select currency from public.honorarios_parcelas where id = '${PARCELA_USD}';`)),
    ).toBe("USD");
  });
});

describe("fn_honorarios_parcela_pagar — o caixa herda a moeda da parcela", () => {
  it("parcela em USD lança no caixa em USD, e não em BRL", () => {
    const pago = JSON.parse(lastLine(sql(`${COMO_GERENTE} ${pagar(ORG_USD, PARCELA_USD, CONTA_USD)}`)));
    expect(pago).toMatchObject({ id: PARCELA_USD, status: "pago" });

    expect(moedaDoLancamentoDa(PARCELA_USD)).toBe("USD");
  });

  it("parcela antiga (sem moeda declarada) cai no default 'BRL' — sem conversão silenciosa", () => {
    sql(`
      insert into public.honorarios_parcelas
        (id, organization_id, contrato_id, numero, vencimento, valor_cents)
      values
        ('${PARCELA_SEM_MOEDA}', '${ORG_BRL}', '${CONTRATO_BRL}', 1, '2026-11-10', 50000)
        on conflict (id) do nothing;
    `);

    JSON.parse(lastLine(sql(`${COMO_GERENTE} ${pagar(ORG_BRL, PARCELA_SEM_MOEDA, CONTA_BRL)}`)));

    expect(moedaDoLancamentoDa(PARCELA_SEM_MOEDA)).toBe("BRL");
  });
});
