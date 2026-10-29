import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * QUEM FOI APAGADO A PEDIDO NÃO VOLTA PELA IMPORTAÇÃO DO HISTÓRICO (migration 0741, doc 186).
 *
 * A anonimização passa pelo caminho de produção (`fn_lgpd_cascade_redact_contact`),
 * não por um UPDATE à mão: é o gatilho dela que tem de deixar a marca. O que se
 * prova, nas duas direções:
 *   - a marca nasce, sem o número em claro, e responde "sim" para as duas grafias
 *     do nono dígito e para o lid;
 *   - ela NÃO responde "sim" para outro número nem para a mesma pessoa noutra
 *     empresa, e o navegador (authenticated, anon) não a lê nem chama a pergunta.
 */

const ORG_A = "0741a000-0000-4000-8000-00000000000a";
const ORG_B = "0741a000-0000-4000-8000-00000000000b";
const MEMBRO_A = "0741a000-1111-4000-8000-000000000001";
const APAGADO = "0741a000-2222-4000-8000-000000000001";
const SEM_TELEFONE = "0741a000-2222-4000-8000-000000000002";
const MESMO_NUMERO_EM_B = "0741a000-2222-4000-8000-000000000003";
const TELEFONE = "+5511987654321";

function apagado(org: string, telefone: string | null, lid: string | null): string {
  const t = telefone === null ? "null" : `'${telefone}'`;
  const l = lid === null ? "null" : `'${lid}'`;
  return sql(`select public.fn_titular_apagado_a_pedido('${org}', ${t}, ${l});`);
}

function marcasDe(org: string): string {
  return sql(`select count(*) from public.lgpd_marcas_de_apagamento where organization_id = '${org}';`);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO_A}', 'marca-apagamento@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'marca-apagamento-a', 'Marca A', 'Marca A'),
      ('${ORG_B}', 'marca-apagamento-b', 'Marca B', 'Marca B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MEMBRO_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number, source_metadata) values
      ('${APAGADO}', '${ORG_A}', 'Maria Apagada', '${TELEFONE}', '{"waha_lid":"998877@lid"}'),
      ('${SEM_TELEFONE}', '${ORG_A}', 'Sem Telefone', null, '{}'),
      ('${MESMO_NUMERO_EM_B}', '${ORG_B}', 'Maria em B', '${TELEFONE}', '{}')
      on conflict (id) do nothing;
  `);
  for (const contato of [APAGADO, SEM_TELEFONE]) {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${contato}', gen_random_uuid());`);
  }
});

describe("marca de quem foi apagado a pedido", () => {
  it("a anonimização deixa UMA marca, e ela não guarda o número nem o lid em claro", () => {
    expect(sql(`select phone_number is null and is_anonymized from public.contacts where id = '${APAGADO}';`)).toBe("t");
    expect(marcasDe(ORG_A)).toBe("1");
    expect(
      sql(`
        select bool_and(
                 position(convert_to('11987654321', 'UTF8') in coalesce(marca_telefone, ''::bytea)) = 0
             and position(convert_to('998877', 'UTF8') in coalesce(marca_lid, ''::bytea)) = 0
             and marca_telefone is not null and marca_lid is not null)
          from public.lgpd_marcas_de_apagamento where organization_id = '${ORG_A}';
      `),
    ).toBe("t");
  });

  it("contato sem telefone e sem lid não deixa marca vazia", () => {
    expect(sql(`select is_anonymized from public.contacts where id = '${SEM_TELEFONE}';`)).toBe("t");
    expect(marcasDe(ORG_A)).toBe("1");
  });

  it("anonimizar de novo não duplica a marca", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${APAGADO}', gen_random_uuid());`);
    expect(marcasDe(ORG_A)).toBe("1");
  });

  it("responde sim para o número, para a grafia sem o nono dígito e para o lid", () => {
    expect(apagado(ORG_A, TELEFONE, null)).toBe("t");
    expect(apagado(ORG_A, "551187654321", null)).toBe("t");
    expect(apagado(ORG_A, "5511987654321@c.us", null)).toBe("t");
    expect(apagado(ORG_A, null, "998877@lid")).toBe("t");
    expect(apagado(ORG_A, null, "998877")).toBe("t");
  });

  it("responde não para outro número, outro lid, nada, e para a mesma pessoa noutra empresa", () => {
    expect(apagado(ORG_A, "+5511987654322", null)).toBe("f");
    expect(apagado(ORG_A, null, "998878@lid")).toBe("f");
    expect(apagado(ORG_A, null, null)).toBe("f");
    expect(apagado(ORG_A, "", "")).toBe("f");
    expect(apagado(ORG_B, TELEFONE, "998877@lid")).toBe("f");
    expect(marcasDe(ORG_B)).toBe("0");
  });

  it("só o servidor lê a marca e faz a pergunta", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.lgpd_marcas_de_apagamento'::regclass;`)).toBe("t");
    expect(
      sql(`
        select bool_and(not has_table_privilege(r, 'public.lgpd_marcas_de_apagamento', o))
          from unnest(array['anon', 'authenticated']) r
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) o;
      `),
    ).toBe("t");
    expect(
      sql(`
        select not has_function_privilege('anon', 'public.fn_titular_apagado_a_pedido(uuid,text,text)', 'EXECUTE')
           and not has_function_privilege('authenticated', 'public.fn_titular_apagado_a_pedido(uuid,text,text)', 'EXECUTE')
           and has_function_privilege('service_role', 'public.fn_titular_apagado_a_pedido(uuid,text,text)', 'EXECUTE')
           and not has_function_privilege('authenticated', 'public.fn_lgpd_guardar_marca_de_apagamento()', 'EXECUTE');
      `),
    ).toBe("t");
    // Membro da PRÓPRIA organização, com JWT de verdade: recusado, não "zero linhas".
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
        select count(*) from public.lgpd_marcas_de_apagamento;
      `),
    ).toThrow(/permission denied/);
  });
});
