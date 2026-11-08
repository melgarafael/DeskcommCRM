import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const ORG_B = "cccccccc-9999-4000-8000-00000000e0b0";
const UNIT_A = "cccccccc-9999-4000-8000-00000000e001";
const UNIT_B = "cccccccc-9999-4000-8000-00000000e002";
const AG_A = "cccccccc-9999-4000-8000-00000000e011";
const AG_B = "cccccccc-9999-4000-8000-00000000e012";
const CONTACT_B = "cccccccc-9999-4000-8000-00000000e021";

function existe(tabela: string, id: string): boolean {
  return lastLine(sql(`select exists(select 1 from public.${tabela} where id = '${id}')::text;`)) === "true";
}

beforeAll(() => {
  seedGov();
  sql(`
    select public.fn_avaliacao_provisionar();

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_B}', 'avaliacao-rls-b', 'Avaliacao RLS B', 'Av RLS B')
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name, phone_number, source) values
      ('${CONTACT_B}', '${ORG_B}', 'Contato B', '+5511999990001', 'manual')
      on conflict (id) do nothing;

    insert into public.avaliacao_unidades (id, organization_id, name) values
      ('${UNIT_A}', '${GOV_ORG}', 'Unidade Gov'),
      ('${UNIT_B}', '${ORG_B}', 'Unidade B')
      on conflict (id) do nothing;

    insert into public.avaliacao_agendamentos (
      id, organization_id, contact_id, unit_id, scheduled_at, status
    ) values
      ('${AG_A}', '${GOV_ORG}', '${GOV_CONTACT_1}', '${UNIT_A}', now() + interval '1 day', 'agendado'),
      ('${AG_B}', '${ORG_B}', '${CONTACT_B}', '${UNIT_B}', now() + interval '1 day', 'agendado')
      on conflict (id) do nothing;
  `);
});

describe("isolamento cross-tenant", () => {
  it("viewer da org A não vê agendamento da org B", () => {
    expect(
      Number(
        lastLine(
          sql(`
            set role authenticated;
            select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', false);
            select count(*) from public.avaliacao_agendamentos where id = '${AG_B}';
          `),
        ),
      ),
    ).toBe(0);
  });
});

describe("papéis na org A", () => {
  it("viewer não cria agendamento", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.avaliacao_agendamentos (organization_id, contact_id, unit_id, scheduled_at)
         values ('${GOV_ORG}', '${GOV_CONTACT_1}', '${UNIT_A}', now() + interval '2 days')`,
      ),
    ).toBe(0);
  });

  it("agent cria agendamento", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.avaliacao_agendamentos (organization_id, contact_id, unit_id, scheduled_at)
         values ('${GOV_ORG}', '${GOV_CONTACT_1}', '${UNIT_A}', now() + interval '3 days')`,
      ),
    ).toBe(1);
  });

  it("agent não apaga — delete exige manager", () => {
    expect(writeCountAs(GOV_AGENT_A, `delete from public.avaliacao_agendamentos where id = '${AG_A}'`)).toBe(0);
    expect(existe("avaliacao_agendamentos", AG_A)).toBe(true);
  });

  it("manager apaga", () => {
    const idDescarte = "cccccccc-9999-4000-8000-00000000e099";
    sql(`
      insert into public.avaliacao_agendamentos (id, organization_id, contact_id, unit_id, scheduled_at)
      values ('${idDescarte}', '${GOV_ORG}', '${GOV_CONTACT_1}', '${UNIT_A}', now() + interval '4 days')
      on conflict (id) do nothing;
    `);
    expect(writeCountAs(GOV_MANAGER, `delete from public.avaliacao_agendamentos where id = '${idDescarte}'`)).toBe(1);
  });

  it("status direto na sessão é bloqueado pelo trigger", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.avaliacao_agendamentos set status = 'cancelado' where id = '${AG_A}'`),
    ).toBe(0);
  });
});

describe("fn_avaliacao_transicao_status", () => {
  it("transição inválida recusa", () => {
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
        select public.fn_avaliacao_transicao_status(
          '${GOV_ORG}'::uuid,
          '${AG_A}'::uuid,
          'concluir'
        );
      `),
    ).toThrow();
  });
});
