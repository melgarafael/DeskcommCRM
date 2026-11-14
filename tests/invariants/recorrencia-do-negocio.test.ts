import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

/**
 * A RECORRÊNCIA DO NEGÓCIO NO BANCO (#3602, fatias 3 e 4) — migration 9316.
 *
 * ## O que este arquivo prende
 *
 * O código (`lib/financeiro/recorrencia-do-negocio.ts`) cria UM molde ativo por
 * negócio ganho e desativa o molde do negócio perdido. Duas dessas promessas
 * são do BANCO, não do código, e é por isso que estão aqui:
 *
 *   1. `recurring_entries.crm_lead_id` é nullable e a FK é `on delete set null`
 *      — apagar o negócio não pode apagar o molde que já explicou lançamentos
 *      pagos nem deixar a coluna apontando para o nada;
 *   2. `recurring_entries_org_lead_uidx` é ÚNICO e PARCIAL — "entrar de novo na
 *      etapa não duplica" sobrevive à corrida de dois arrastos, e molde digitado
 *      à mão (sem negócio) continua podendo repetir.
 *
 * ## Isolamento por empresa
 *
 * A função que escreve usa admin client (o agente de IA que fecha o negócio não
 * é `manager` da organização), então o isolamento NÃO vem do RLS na escrita:
 * vem do `organization_id` gravado e filtrado em toda consulta. Aqui se mede o
 * filtro na prática — o UPDATE com o `organization_id` da A não toca o molde da
 * B — e, na leitura, a policy de tenant também recorta.
 *
 * ## Por que a data de criação é fixa
 *
 * `day_of_month` sai do `created_at` do negócio; o molde da semente nasce com o
 * dia já calculado (5), e o teste do cálculo em UTC está no unit
 * (`lib/financeiro/recorrencia-do-negocio.test.ts`).
 */

const ORG_A = "f2f2f2f2-0000-4000-8000-000000000001";
const ORG_B = "f2f2f2f2-0000-4000-8000-000000000002";
const USER_A = "f2f2f2f2-1111-4000-8000-000000000001";
const USER_B = "f2f2f2f2-1111-4000-8000-000000000002";
const CONTA_A = "f2f2f2f2-2222-4000-8000-000000000001";
const CONTA_B = "f2f2f2f2-2222-4000-8000-000000000002";
const FUNIL_A = "f2f2f2f2-3333-4000-8000-000000000001";
const FUNIL_B = "f2f2f2f2-3333-4000-8000-000000000002";
const ETAPA_A = "f2f2f2f2-4444-4000-8000-000000000001";
const ETAPA_B = "f2f2f2f2-4444-4000-8000-000000000002";
const LEAD_A = "f2f2f2f2-5555-4000-8000-000000000001";
const LEAD_B = "f2f2f2f2-5555-4000-8000-000000000002";
const MOLDE_A = "f2f2f2f2-6666-4000-8000-000000000001";
const MOLDE_B = "f2f2f2f2-6666-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'recorrencia-negocio-a@invariant.test'),
      ('${USER_B}', 'recorrencia-negocio-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'rec-negocio-a', 'Recorrencia Negocio A', 'Rec Neg A'),
      ('${ORG_B}', 'rec-negocio-b', 'Recorrencia Negocio B', 'Rec Neg B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'manager', now()),
      ('${USER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.financial_accounts (id, organization_id, name) values
      ('${CONTA_A}', '${ORG_A}', 'Caixa rec A'),
      ('${CONTA_B}', '${ORG_B}', 'Caixa rec B')
      on conflict (id) do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${FUNIL_A}', '${ORG_A}', 'Vendas A', 'rec-neg-a'),
      ('${FUNIL_B}', '${ORG_B}', 'Vendas B', 'rec-neg-b')
      on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won) values
      ('${ETAPA_A}', '${ORG_A}', '${FUNIL_A}', 'Ganho A', 'ganho-a', 1000, true),
      ('${ETAPA_B}', '${ORG_B}', '${FUNIL_B}', 'Ganho B', 'ganho-b', 1000, true)
      on conflict (id) do nothing;

    -- O created_at é a origem do day_of_month: dia 5 em UTC.
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, status, created_at,
       recurring_value_cents, recurring_period)
    values
      ('${LEAD_A}', '${ORG_A}', '${FUNIL_A}', '${ETAPA_A}', 'Negocio A', 'won', '2026-03-05T23:30:00Z', 50000, 'monthly'),
      ('${LEAD_B}', '${ORG_B}', '${FUNIL_B}', '${ETAPA_B}', 'Negocio B', 'won', '2026-03-05T23:30:00Z', 90000, 'monthly')
      on conflict (id) do nothing;

    -- Um molde de cada organização, ligado ao negócio dela (o que o ganho grava).
    insert into public.recurring_entries
      (id, organization_id, crm_lead_id, name, account_id, direction, amount_cents,
       currency, day_of_month, is_active)
    values
      ('${MOLDE_A}', '${ORG_A}', '${LEAD_A}', 'Recorrência · Vendas A', '${CONTA_A}', 'in', 50000, 'BRL', 5, true),
      ('${MOLDE_B}', '${ORG_B}', '${LEAD_B}', 'Recorrência · Vendas B', '${CONTA_B}', 'in', 90000, 'BRL', 5, true)
      on conflict (id) do nothing;
  `);
});

/** Insere um molde cru, como o código grava (admin client). */
function inserirMolde(
  id: string,
  org: string,
  conta: string,
  leadId: string | null,
  ativo = true,
): string {
  return `
    insert into public.recurring_entries
      (id, organization_id, crm_lead_id, name, account_id, direction, amount_cents,
       currency, day_of_month, is_active)
    values
      ('${id}', '${org}', ${leadId === null ? "null" : `'${leadId}'`}, 'Recorrência · Vendas',
       '${conta}', 'in', 50000, 'BRL', 5, ${ativo});
  `;
}

describe("recurring_entries.crm_lead_id — a coluna de origem (9316)", () => {
  it("existe, é nullable e a FK é on delete set null", () => {
    expect(
      sql(`
        select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'recurring_entries'
           and column_name = 'crm_lead_id';
      `),
    ).toBe("YES");

    // `n` = ON DELETE SET NULL em pg_constraint.confdeltype.
    expect(
      sql(`
        select confdeltype from pg_constraint
         where conrelid = 'public.recurring_entries'::regclass
           and conname = 'recurring_entries_crm_lead_id_fkey';
      `),
    ).toBe("n");
  });

  it("o índice do vínculo é UNIQUE e PARCIAL (molde sem negócio não entra nele)", () => {
    const definicao = sql(`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'recurring_entries_org_lead_uidx';
    `);
    expect(definicao).toContain("UNIQUE INDEX");
    expect(definicao).toContain("crm_lead_id IS NOT NULL");
  });
});

describe("um molde por negócio — a idempotência é do banco", () => {
  it("o segundo molde para o MESMO negócio é recusado pelo índice único", () => {
    expect(() => sql(inserirMolde("f2f2f2f2-6666-4000-8000-000000000099", ORG_A, CONTA_A, LEAD_A))).toThrow(
      /duplicate key|unique constraint/i,
    );
  });

  it("molde digitado à mão (sem negócio) pode repetir — o índice é parcial", () => {
    expect(() =>
      sql(`
        ${inserirMolde("f2f2f2f2-6666-4000-8000-000000000011", ORG_A, CONTA_A, null)}
        ${inserirMolde("f2f2f2f2-6666-4000-8000-000000000012", ORG_A, CONTA_A, null)}
      `),
    ).not.toThrow();
    expect(
      sql(`
        select count(*) from public.recurring_entries
         where organization_id = '${ORG_A}' and crm_lead_id is null;
      `),
    ).toBe("2");
  });

  it("cada negócio tem UM molde, e o da outra organização não colide", () => {
    // O índice é (organization_id, crm_lead_id): o mesmo negócio em outra
    // empresa não é duplicata, e cada vínculo tem a sua linha.
    expect(
      sql(`
        select count(*) from public.recurring_entries
         where crm_lead_id in ('${LEAD_A}', '${LEAD_B}');
      `),
    ).toBe("2");
    expect(
      sql(`
        select count(*) from public.recurring_entries
         where organization_id = '${ORG_B}' and crm_lead_id = '${LEAD_B}';
      `),
    ).toBe("1");
  });
});

describe("isolamento por empresa — o molde da outra organização não aparece nem é tocado", () => {
  it("a leitura de quem é da A só enxerga o molde da A", () => {
    const daA = countAs(
      USER_A,
      `select count(*) from public.recurring_entries where organization_id = '${ORG_A}';`,
    );
    const daB = countAs(
      USER_A,
      `select count(*) from public.recurring_entries where organization_id = '${ORG_B}';`,
    );
    expect(daA).toBeGreaterThan(0);
    expect(daB).toBe(0);
  });

  it("a desativação com o organization_id da A não toca no molde da B", () => {
    // A MESMA escrita que `desativaRecorrenciaDoNegocio` faz (admin client):
    // update ... where organization_id = A and crm_lead_id = LEAD_A.
    sql(`
      update public.recurring_entries
         set is_active = false, updated_at = now()
       where organization_id = '${ORG_A}' and crm_lead_id = '${LEAD_A}' and is_active = true;
    `);

    expect(
      sql(`
        select is_active from public.recurring_entries
         where organization_id = '${ORG_A}' and crm_lead_id = '${LEAD_A}';
      `),
    ).toBe("f");
    // O da B segue ativo: a perda da A não desativa a recorrência de ninguém além dela.
    expect(
      sql(`
        select is_active from public.recurring_entries
         where organization_id = '${ORG_B}' and crm_lead_id = '${LEAD_B}';
      `),
    ).toBe("t");
  });

  it("apagar o negócio corta o vínculo e NÃO apaga o molde (on delete set null)", () => {
    const antes = Number(
      sql(`select count(*) from public.recurring_entries where organization_id = '${ORG_A}';`),
    );

    sql(`delete from public.crm_leads where id = '${LEAD_A}';`);

    expect(
      sql(`
        select count(*) from public.recurring_entries where organization_id = '${ORG_A}';
      `),
    ).toBe(String(antes));
    expect(
      sql(`
        select count(*) from public.recurring_entries
         where organization_id = '${ORG_A}' and crm_lead_id = '${LEAD_A}';
      `),
    ).toBe("0");
    // A linha do molde sobreviveu — só perdeu o vínculo.
    expect(
      sql(`select count(*) from public.recurring_entries where id = '${MOLDE_A}';`),
    ).toBe("1");
  });
});

describe("recurring_entries.ends_on — o fim do contrato (9371, doc 312 = A)", () => {
  it("existe, é date e nullable (nulo = sem prazo, como todo molde digitado à mão)", () => {
    expect(
      sql(`
        select data_type || '|' || is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'recurring_entries'
           and column_name = 'ends_on';
      `),
    ).toBe("date|YES");
  });

  it("molde criado sem informar o fim nasce sem prazo", () => {
    expect(
      sql(`select coalesce(ends_on::text, 'nulo') from public.recurring_entries where id = '${MOLDE_B}';`),
    ).toBe("nulo");
  });
});
