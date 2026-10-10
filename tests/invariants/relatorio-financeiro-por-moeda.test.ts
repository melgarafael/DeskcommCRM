import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * RELATÓRIO FINANCEIRO — cada moeda no seu bloco, nunca uma soma entre elas
 * (#1531, migration 0444).
 *
 * ## O defeito que este arquivo prende
 *
 * `fn_relatorio_financeiro` somava `amount_cents` e `total_cents` sem olhar a
 * moeda: R$ 150,00 mais 200,00 € viravam 35000, e a tela escrevia isso em
 * real. A 0444 acrescentou `por_moeda` — os mesmos totais e listas do topo,
 * calculados só com as linhas de cada moeda. Os casos de valor abaixo leem
 * esse campo; contra o corpo da 0356 (sem ele), todos vermelham.
 *
 * ## E o contrato
 *
 * A mudança é ADITIVA (docs/doctrine/versionamento.md): as treze chaves de
 * antes continuam com a mesma conta. O caso "o topo continua o da 0356" existe
 * para que uma "correção" futura que troque o significado de `faturado_cents`
 * vermelhe aqui, e não no script de quem já consumia o relatório.
 *
 * ## A pessoa de duas organizações
 *
 * A função é INVOKER: a RLS recorta a sessão, e o `p_org` recorta entre as
 * organizações que a sessão enxerga. A pessoa das DUAS organizações é o caso
 * que mede o filtro explícito (o mesmo raciocínio de
 * `relatorio-de-atividades.test.ts`): sem ele, o euro da B entraria no bloco
 * do euro da A.
 *
 * Valores distintos de propósito, para que nenhuma soma errada coincida com
 * uma certa: BRL 100,00 + 50,00, EUR 200,00, e 999,99 € na organização B.
 */

const ORG_A = "f1f1f1f1-0000-4000-8000-000000000001";
const ORG_B = "f1f1f1f1-0000-4000-8000-000000000002";
/** Pertence às DUAS — mede o filtro explícito por `p_org`. */
const USER_MULTI = "f1f1f1f1-1111-4000-8000-000000000001";

const CONTA_A = "f1f1f1f1-2222-4000-8000-000000000001";
const CONTA_B = "f1f1f1f1-2222-4000-8000-000000000002";
const PIX_A = "f1f1f1f1-3333-4000-8000-000000000001";
const CARTAO_A = "f1f1f1f1-3333-4000-8000-000000000002";
const FORMA_B = "f1f1f1f1-3333-4000-8000-000000000003";
const CONTATO_A = "f1f1f1f1-4444-4000-8000-000000000001";

const VENDA_BRL_1 = "f1f1f1f1-5555-4000-8000-000000000001";
const VENDA_BRL_2 = "f1f1f1f1-5555-4000-8000-000000000002";
const VENDA_EUR = "f1f1f1f1-5555-4000-8000-000000000003";
const VENDA_B = "f1f1f1f1-5555-4000-8000-000000000004";
const ITEM_BRL_1 = "f1f1f1f1-6666-4000-8000-000000000001";
const ITEM_BRL_2 = "f1f1f1f1-6666-4000-8000-000000000002";
const ITEM_EUR = "f1f1f1f1-6666-4000-8000-000000000003";

/** Janeiro inteiro: as duas moedas. A primeira quinzena: só o real. */
const JANEIRO = ["2026-01-01", "2026-01-31"] as const;
const SO_REAL = ["2026-01-01", "2026-01-15"] as const;
const SEM_MOVIMENTO = ["2025-01-01", "2025-01-31"] as const;

type Linha = Record<string, unknown>;
type Totais = {
  entradas_cents: number;
  saidas_cents: number;
  saldo_cents: number;
  comandas_finalizadas: number;
  comandas_estornadas: number;
  faturado_cents: number;
  ticket_medio_cents: number;
  por_forma: Linha[];
  por_profissional: Linha[];
  por_servico: Linha[];
  por_cliente: Linha[];
};
type Relatorio = Totais & { de: string; ate: string; por_moeda?: Record<string, Totais> };

/** Chama a função como `authenticated` com as claims da pessoa, e devolve o jsonb. */
function relatorio(org: string, [de, ate]: readonly [string, string]): Relatorio {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_MULTI}"}', false);
    select public.fn_relatorio_financeiro('${org}'::uuid, '${de}'::date, '${ate}'::date)::text;
  `);
  return JSON.parse(lastLine(out)) as Relatorio;
}

beforeAll(() => {
  // O módulo financeiro INSTALADO antes de semear (#1907, item 3): `sales` e
  // `sale_items` saíram do `baseline.sql` e nascem na provisionadora
  // (ADR-0002 D2/D3) — sem ela o seed morre com `relation "sales" does not
  // exist`. A D8 manda a varredura rodar COM o módulo, não perder cobertura.
  sql("select public.fn_financeiro_provisionar();");
  sql(`
    insert into auth.users (id, email) values
      ('${USER_MULTI}', 'rel-fin-moeda-multi@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'rel-fin-moeda-a', 'Relatorio Financeiro Moeda A', 'Rel Fin A'),
      ('${ORG_B}', 'rel-fin-moeda-b', 'Relatorio Financeiro Moeda B', 'Rel Fin B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_MULTI}', '${ORG_A}', 'manager', now()),
      ('${USER_MULTI}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.financial_accounts (id, organization_id, name) values
      ('${CONTA_A}', '${ORG_A}', 'Caixa invariante A'),
      ('${CONTA_B}', '${ORG_B}', 'Caixa invariante B')
      on conflict (id) do nothing;

    insert into public.payment_methods (id, organization_id, name) values
      ('${PIX_A}', '${ORG_A}', 'Pix'),
      ('${CARTAO_A}', '${ORG_A}', 'Cartão'),
      ('${FORMA_B}', '${ORG_B}', 'Dinheiro')
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name) values
      ('${CONTATO_A}', '${ORG_A}', 'Cliente invariante')
      on conflict (id) do nothing;

    -- Inseridas DIRETO, e não por fn_finalizar_comanda: o que se mede aqui é a
    -- conta do relatório, e passar pela função amarraria a semente a ela. A
    -- segunda comanda em real está estornada, para o contador por moeda ter o
    -- que contar.
    insert into public.sales
      (id, organization_id, number, contact_id, payment_method_id, status,
       total_cents, currency, finalized_at, reversed_at) values
      ('${VENDA_BRL_1}', '${ORG_A}', 1, '${CONTATO_A}', '${PIX_A}',    'finalized', 10000, 'BRL', '2026-01-10 12:00Z', null),
      ('${VENDA_BRL_2}', '${ORG_A}', 2, '${CONTATO_A}', '${PIX_A}',    'finalized',  5000, 'BRL', '2026-01-11 12:00Z', '2026-01-12 12:00Z'),
      ('${VENDA_EUR}',   '${ORG_A}', 3, '${CONTATO_A}', '${CARTAO_A}', 'finalized', 20000, 'EUR', '2026-01-20 12:00Z', null),
      ('${VENDA_B}',     '${ORG_B}', 1, null,           '${FORMA_B}',  'finalized', 99999, 'EUR', '2026-01-20 12:00Z', null)
      on conflict (id) do nothing;

    -- O MESMO serviço nas duas moedas: é o caso em que a lista do topo junta
    -- real com euro numa linha só.
    insert into public.sale_items
      (id, organization_id, sale_id, description, attendant_user_id,
       unit_price_cents, total_cents, commission_percent) values
      ('${ITEM_BRL_1}', '${ORG_A}', '${VENDA_BRL_1}', 'Corte', '${USER_MULTI}', 10000, 10000, 10),
      ('${ITEM_BRL_2}', '${ORG_A}', '${VENDA_BRL_2}', 'Corte', '${USER_MULTI}',  5000,  5000, 10),
      ('${ITEM_EUR}',   '${ORG_A}', '${VENDA_EUR}',   'Corte', '${USER_MULTI}', 20000, 20000, 10)
      on conflict (id) do nothing;

    insert into public.commissions
      (id, organization_id, sale_item_id, attendant_user_id, percent, amount_cents) values
      ('f1f1f1f1-7777-4000-8000-000000000001', '${ORG_A}', '${ITEM_BRL_1}', '${USER_MULTI}', 10, 1000),
      ('f1f1f1f1-7777-4000-8000-000000000002', '${ORG_A}', '${ITEM_BRL_2}', '${USER_MULTI}', 10,  500),
      ('f1f1f1f1-7777-4000-8000-000000000003', '${ORG_A}', '${ITEM_EUR}',   '${USER_MULTI}', 10, 2000)
      on conflict (id) do nothing;

    insert into public.financial_entries
      (id, organization_id, account_id, direction, amount_cents, currency,
       entry_date, status, paid_at, origin) values
      ('f1f1f1f1-8888-4000-8000-000000000001', '${ORG_A}', '${CONTA_A}', 'in',  15000, 'BRL', '2026-01-11', 'paid', now(), 'manual'),
      ('f1f1f1f1-8888-4000-8000-000000000002', '${ORG_A}', '${CONTA_A}', 'out',  3000, 'BRL', '2026-01-12', 'paid', now(), 'manual'),
      ('f1f1f1f1-8888-4000-8000-000000000003', '${ORG_A}', '${CONTA_A}', 'in',  20000, 'EUR', '2026-01-20', 'paid', now(), 'manual'),
      ('f1f1f1f1-8888-4000-8000-000000000004', '${ORG_B}', '${CONTA_B}', 'in',  99999, 'EUR', '2026-01-20', 'paid', now(), 'manual')
      on conflict (id) do nothing;
  `);
});

describe("relatório financeiro — a função", () => {
  it("continua SECURITY INVOKER (o escopo é a RLS, não uma checagem paralela)", () => {
    const linha = sql(`
      select p.prosecdef
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_relatorio_financeiro';
    `);
    expect(linha).toBe("f");
  });

  it("não é alcançável pela anon key, e é alcançável por quem tem sessão", () => {
    const assinatura = "public.fn_relatorio_financeiro(uuid,date,date)";
    expect(sql(`select has_function_privilege('anon', '${assinatura}', 'EXECUTE');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', '${assinatura}', 'EXECUTE');`)).toBe(
      "t",
    );
  });
});

describe("relatório financeiro — cada moeda no seu bloco", () => {
  it("cada moeda tem os seus totais, só com as linhas dela", () => {
    const { por_moeda } = relatorio(ORG_A, JANEIRO);
    expect(Object.keys(por_moeda ?? {}).sort()).toEqual(["BRL", "EUR"]);

    expect(por_moeda?.BRL).toMatchObject({
      entradas_cents: 15000,
      saidas_cents: 3000,
      saldo_cents: 12000,
      comandas_finalizadas: 2,
      comandas_estornadas: 1,
      faturado_cents: 15000,
    });
    expect(por_moeda?.EUR).toMatchObject({
      entradas_cents: 20000,
      saidas_cents: 0,
      saldo_cents: 20000,
      comandas_finalizadas: 1,
      comandas_estornadas: 0,
      faturado_cents: 20000,
    });
  });

  it("o ticket médio é de cada moeda, e o do topo segue a conta de antes", () => {
    const r = relatorio(ORG_A, JANEIRO);
    expect(Number(r.por_moeda?.BRL?.ticket_medio_cents)).toBe(7500);
    expect(Number(r.por_moeda?.EUR?.ticket_medio_cents)).toBe(20000);
    expect(Number(r.ticket_medio_cents)).toBeCloseTo(35000 / 3, 6);
  });

  it("as listas também separam: forma, serviço, cliente e comissão", () => {
    const { por_moeda } = relatorio(ORG_A, JANEIRO);

    expect(por_moeda?.BRL?.por_forma).toEqual([{ nome: "Pix", quantidade: 2, total_cents: 15000 }]);
    expect(por_moeda?.EUR?.por_forma).toEqual([
      { nome: "Cartão", quantidade: 1, total_cents: 20000 },
    ]);

    expect(por_moeda?.BRL?.por_servico).toEqual([
      { nome: "Corte", quantidade: 2, total_cents: 15000 },
    ]);
    expect(por_moeda?.EUR?.por_servico).toEqual([
      { nome: "Corte", quantidade: 1, total_cents: 20000 },
    ]);

    expect(por_moeda?.BRL?.por_cliente).toEqual([
      { contact_id: CONTATO_A, comandas: 2, total_cents: 15000 },
    ]);
    expect(por_moeda?.EUR?.por_cliente).toEqual([
      { contact_id: CONTATO_A, comandas: 1, total_cents: 20000 },
    ]);

    expect(por_moeda?.BRL?.por_profissional).toEqual([
      { attendant_user_id: USER_MULTI, itens: 2, comissao_cents: 1500 },
    ]);
    expect(por_moeda?.EUR?.por_profissional).toEqual([
      { attendant_user_id: USER_MULTI, itens: 1, comissao_cents: 2000 },
    ]);
  });

  it("os campos do topo continuam os da 0356 — a soma de todas as moedas (contrato)", () => {
    const r = relatorio(ORG_A, JANEIRO);
    expect(r).toMatchObject({
      de: JANEIRO[0],
      ate: JANEIRO[1],
      entradas_cents: 35000,
      saidas_cents: 3000,
      saldo_cents: 32000,
      comandas_finalizadas: 3,
      comandas_estornadas: 1,
      faturado_cents: 35000,
    });
    expect(r.por_servico).toEqual([{ nome: "Corte", quantidade: 3, total_cents: 35000 }]);
    expect(r.por_cliente).toEqual([{ contact_id: CONTATO_A, comandas: 3, total_cents: 35000 }]);
    expect(r.por_profissional).toEqual([
      { attendant_user_id: USER_MULTI, itens: 3, comissao_cents: 3500 },
    ]);
    expect(r.por_forma).toEqual([
      { nome: "Cartão", quantidade: 1, total_cents: 20000 },
      { nome: "Pix", quantidade: 2, total_cents: 15000 },
    ]);
  });

  it("com uma moeda só no período, o bloco dela é igual ao topo", () => {
    const { de: _de, ate: _ate, por_moeda, ...topo } = relatorio(ORG_A, SO_REAL);
    expect(Object.keys(por_moeda ?? {})).toEqual(["BRL"]);
    expect(por_moeda?.BRL).toEqual(topo);
    expect(topo.faturado_cents).toBe(15000);
  });

  it("período sem movimento devolve por_moeda vazio e o topo zerado", () => {
    const r = relatorio(ORG_A, SEM_MOVIMENTO);
    expect(r.por_moeda).toEqual({});
    expect(r).toMatchObject({ entradas_cents: 0, faturado_cents: 0, comandas_finalizadas: 0 });
  });

  it("a pessoa das DUAS organizações recebe o euro da que pediu, nunca a soma", () => {
    const a = relatorio(ORG_A, JANEIRO);
    expect(a.por_moeda?.EUR?.faturado_cents).toBe(20000);
    expect(a.por_moeda?.EUR?.entradas_cents).toBe(20000);

    const b = relatorio(ORG_B, JANEIRO);
    expect(Object.keys(b.por_moeda ?? {})).toEqual(["EUR"]);
    expect(b.por_moeda?.EUR?.faturado_cents).toBe(99999);
  });
});
