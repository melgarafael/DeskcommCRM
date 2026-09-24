import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Isolamento RLS + dedupe do import companies/people (migration 0239).
 * Roda só via `pnpm test:db`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG_A = "cccccccc-0000-4000-8000-000000000001";
const ORG_B = "dddddddd-0000-4000-8000-000000000002";
const USER_A = "cccccccc-1111-4000-8000-000000000001";
const USER_B = "dddddddd-1111-4000-8000-000000000002";

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'b2b-a@invariant.test'),
      ('${USER_B}', 'b2b-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'b2b-inv-a', 'B2B A', 'B2B A'),
      ('${ORG_B}', 'b2b-inv-b', 'B2B B', 'B2B B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'manager', now()),
      ('${USER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
});

describe("companies/people schema (0239)", () => {
  it("tabelas e contacts.person_id existem", () => {
    const out = sql(`
      select count(*) from information_schema.tables
       where table_schema='public'
         and table_name in ('companies','people','company_people','import_batches','import_rows');
    `);
    expect(out.split("\n").pop()).toBe("5");
    const col = sql(`
      select count(*) from information_schema.columns
       where table_schema='public' and table_name='contacts' and column_name='person_id';
    `);
    expect(col.split("\n").pop()).toBe("1");
  });

  it("RLS: user A não vê company de B", () => {
    sql(`
      delete from public.companies where organization_id in ('${ORG_A}','${ORG_B}');
      insert into public.companies (organization_id, trade_name, legal_name, normalized_cnpj, cnpj)
        values ('${ORG_B}', 'Secreta', 'Secreta LTDA', '11222333000181', '11222333000181');
    `);
    const n = countAs(
      USER_A,
      `select count(*)::text from public.companies where organization_id = '${ORG_B}';`,
    );
    expect(n).toBe(0);
  });

  it("mesmo CNPJ na org rejeita segundo insert (unique parcial)", () => {
    sql(`
      delete from public.companies where organization_id = '${ORG_A}' and normalized_cnpj = '99888777000166';
      insert into public.companies (organization_id, trade_name, normalized_cnpj, cnpj)
        values ('${ORG_A}', 'Globo', '99888777000166', '99888777000166');
    `);
    let rejected = false;
    try {
      sql(`
        insert into public.companies (organization_id, trade_name, normalized_cnpj, cnpj)
          values ('${ORG_A}', 'Globo 2', '99888777000166', '99888777000166');
      `);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("companies unique + people/contacts graph", () => {
  it("1 company, 2 people, 4 contacts; person_id same-org; cross-org bloqueado", () => {
    const result = sql(`
      begin;
      delete from public.import_rows where organization_id = '${ORG_A}';
      delete from public.import_batches where organization_id = '${ORG_A}';
      delete from public.contacts where organization_id = '${ORG_A}' and phone_number like '+5585999%';
      delete from public.company_people where organization_id = '${ORG_A}';
      delete from public.people where organization_id = '${ORG_A}';
      delete from public.companies where organization_id = '${ORG_A}';

      insert into public.companies (id, organization_id, trade_name, legal_name, normalized_cnpj, cnpj)
        values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '${ORG_A}', 'Globo', 'Globo LTDA', '55666777000199', '55666777000199');

      insert into public.people (id, organization_id, full_name, normalized_name) values
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '${ORG_A}', 'José', 'jose'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '${ORG_A}', 'Antônio', 'antonio');

      insert into public.company_people (organization_id, company_id, person_id, job_title, is_decision_maker) values
        ('${ORG_A}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Dir', true),
        ('${ORG_A}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Ger', true);

      insert into public.contacts (organization_id, name, display_name, phone_number, person_id, source) values
        ('${ORG_A}', 'José', 'José', '+5585999991111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'import_csv'),
        ('${ORG_A}', 'José', 'José', '+5585988881111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'import_csv'),
        ('${ORG_A}', 'Antonio', 'Antonio', '+5511999992222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'import_csv'),
        ('${ORG_A}', 'Antonio', 'Antonio', '+5511988882222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'import_csv');

      select
        (select count(*) from public.companies where organization_id='${ORG_A}' and normalized_cnpj='55666777000199')::text
        || ',' ||
        (select count(*) from public.people where organization_id='${ORG_A}' and id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'))::text
        || ',' ||
        (select count(*) from public.contacts where organization_id='${ORG_A}' and person_id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'))::text;
      commit;
    `);
    expect(result.split("\n").pop()).toBe("1,2,4");

    // Cross-org: contact A → person B deve falhar
    const cross = sql(`
      do $$
      begin
        begin
          update public.contacts
             set person_id = (
               select id from public.people where organization_id='${ORG_B}' limit 1
             )
           where organization_id='${ORG_A}' and phone_number='+5585999991111';
          -- se não houver person em B, cria e tenta
          if not found then
            null;
          end if;
        exception when others then
          raise notice 'blocked:%', sqlerrm;
        end;
      end $$;

      -- cria person em B e força o update; deve errar
      insert into public.people (id, organization_id, full_name)
        values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', '${ORG_B}', 'Outro')
        on conflict (id) do nothing;

      select case when exists (
        select 1 from (
          select 1 where false
        ) s
      ) then 'x' else (
        select coalesce(
          (select 'fail' from public.contacts
            where organization_id='${ORG_A}' and phone_number='+5585999991111'
              and person_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'),
          'ok'
        )
      ) end;
    `);

    // Attempt the forbidden update and capture error
    let blocked = false;
    try {
      sql(`
        update public.contacts
           set person_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
         where organization_id = '${ORG_A}' and phone_number = '+5585999991111';
      `);
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    void cross;
  });

  it("WAHA path: contact sem person_id continua inserível", () => {
    const out = sql(`
      insert into public.contacts (organization_id, name, display_name, phone_number, source)
        values ('${ORG_A}', 'Desconhecido', 'Desconhecido', '+5585111222333', 'whatsapp')
        returning person_id is null;
    `);
    expect(out.split("\n").pop()).toBe("t");
  });
});
