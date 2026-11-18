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

const ORG_C = "0741a000-0000-4000-8000-00000000000c";
const ORG_D = "0741a000-0000-4000-8000-00000000000d";
const COM_EXTRAS = "0741a000-2222-4000-8000-000000000004";
const SO_COM_EXTRA = "0741a000-2222-4000-8000-000000000005";
const MESMO_EXTRA_EM_D = "0741a000-2222-4000-8000-000000000006";
const EXTRA_REPETE_PRINCIPAL = "0741a000-2222-4000-8000-000000000007";
const EXTRA = "+5521987651234";
const EXTRA_FIXO = "+551133334444";
const EXTRA_SEM_PRINCIPAL = "+5531987650000";

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

describe("a marca cobre todos os telefones da ficha (migration 9241)", () => {
  beforeAll(() => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_C}', 'marca-apagamento-c', 'Marca C', 'Marca C'),
        ('${ORG_D}', 'marca-apagamento-d', 'Marca D', 'Marca D')
        on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, name, phone_number, source_metadata) values
        ('${COM_EXTRAS}', '${ORG_C}', 'Ana Tres Numeros', '+5511976543210', '{"waha_lid":"112233@lid"}'),
        ('${SO_COM_EXTRA}', '${ORG_C}', 'Sem Principal', null, '{}'),
        ('${MESMO_EXTRA_EM_D}', '${ORG_D}', 'Ana em D', '+5511900001111', '{}')
        on conflict (id) do nothing;
      insert into public.contact_phones (organization_id, contact_id, phone_number, tipo, wa_lid) values
        ('${ORG_C}', '${COM_EXTRAS}', '${EXTRA}', 'celular', '445566@lid'),
        ('${ORG_C}', '${COM_EXTRAS}', '${EXTRA_FIXO}', 'fixo', null),
        ('${ORG_C}', '${SO_COM_EXTRA}', '${EXTRA_SEM_PRINCIPAL}', 'celular', null),
        ('${ORG_D}', '${MESMO_EXTRA_EM_D}', '${EXTRA}', 'celular', '445566@lid')
        on conflict do nothing;
    `);
    for (const contato of [COM_EXTRAS, SO_COM_EXTRA]) {
      sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_C}', '${contato}', gen_random_uuid());`);
    }
  });

  it("uma marca por telefone, com sal próprio, e os extras saem da ficha", () => {
    expect(
      sql(`select count(*) from public.contact_phones where contact_id in ('${COM_EXTRAS}', '${SO_COM_EXTRA}');`),
    ).toBe("0");
    expect(marcasDe(ORG_C)).toBe("4");
    expect(
      sql(`
        select count(distinct sal) = 4
           and count(marca_telefone) = 4
           and count(marca_lid) = 2
          from public.lgpd_marcas_de_apagamento where organization_id = '${ORG_C}';
      `),
    ).toBe("t");
  });

  it("nenhuma marca guarda telefone ou lid do extra em claro", () => {
    expect(
      sql(`
        select bool_and(
                 position(convert_to('21987651234', 'UTF8') in marca_telefone) = 0
             and position(convert_to('445566', 'UTF8') in coalesce(marca_lid, ''::bytea)) = 0)
          from public.lgpd_marcas_de_apagamento where organization_id = '${ORG_C}';
      `),
    ).toBe("t");
  });

  it("o extra responde sim nas duas grafias do nono dígito, e o lid dele também", () => {
    expect(apagado(ORG_C, EXTRA, null)).toBe("t");
    expect(apagado(ORG_C, "552187651234", null)).toBe("t");
    expect(apagado(ORG_C, "5521987651234@c.us", null)).toBe("t");
    expect(apagado(ORG_C, null, "445566@lid")).toBe("t");
    expect(apagado(ORG_C, null, "445566")).toBe("t");
  });

  it("o principal continua respondendo, o fixo extra responde e a ficha sem principal também", () => {
    expect(apagado(ORG_C, "+5511976543210", null)).toBe("t");
    expect(apagado(ORG_C, "551176543210", null)).toBe("t");
    expect(apagado(ORG_C, null, "112233@lid")).toBe("t");
    expect(apagado(ORG_C, EXTRA_FIXO, null)).toBe("t");
    expect(apagado(ORG_C, EXTRA_SEM_PRINCIPAL, null)).toBe("t");
    expect(apagado(ORG_C, "553187650000", null)).toBe("t");
  });

  it("responde não para o vizinho do extra", () => {
    expect(apagado(ORG_C, "+5521987651235", null)).toBe("f");
    expect(apagado(ORG_C, null, "445567@lid")).toBe("f");
  });

  it("anonimizar de novo não duplica nenhuma marca", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_C}', '${COM_EXTRAS}', gen_random_uuid());`);
    expect(marcasDe(ORG_C)).toBe("4");
  });

  it("a marca de uma organização não alcança a outra, nos dois sentidos", () => {
    expect(apagado(ORG_D, EXTRA, null)).toBe("f");
    expect(apagado(ORG_D, null, "445566@lid")).toBe("f");
    expect(marcasDe(ORG_D)).toBe("0");
    expect(sql(`select count(*) from public.contact_phones where contact_id = '${MESMO_EXTRA_EM_D}';`)).toBe("1");

    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_D}', '${MESMO_EXTRA_EM_D}', gen_random_uuid());`);
    expect(marcasDe(ORG_D)).toBe("2");
    expect(apagado(ORG_D, EXTRA, null)).toBe("t");
    expect(marcasDe(ORG_C)).toBe("4");
    expect(apagado(ORG_C, "+5511900001111", null)).toBe("f");
  });

  it("extra com o mesmo número do principal gera uma marca só", () => {
    // A regra "um número, uma ficha" recusa este par na escrita; aqui ele entra por fora
    // dela para provar que a marca não depende dessa recusa.
    sql(`
      set session_replication_role = replica;
      insert into public.contacts (id, organization_id, name, phone_number, source_metadata)
        values ('${EXTRA_REPETE_PRINCIPAL}', '${ORG_C}', 'Repetido', '+5541987650000', '{}');
      insert into public.contact_phones (organization_id, contact_id, phone_number, tipo)
        values ('${ORG_C}', '${EXTRA_REPETE_PRINCIPAL}', '+5541987650000', 'celular');
      set session_replication_role = origin;
      select public.fn_lgpd_cascade_redact_contact('${ORG_C}', '${EXTRA_REPETE_PRINCIPAL}', gen_random_uuid());
    `);
    expect(marcasDe(ORG_C)).toBe("5");
  });
});
