/**
 * CRIAR E VINCULAR A PESSOA PELO NEGÓCIO — migration 9112.
 *
 * `fn_create_contact_for_lead` é `security invoker`: quem decide é a RLS do
 * chamador. Aqui ela é chamada de verdade, como o PostgREST chama, porque os
 * testes de rota usam mock e nenhum deles alcança a função. O que só o Postgres
 * prova: o endereço e os campos configurados atravessam o `jsonb_populate_record`,
 * o INSERT e o UPDATE são uma coisa só, e o JSON não escolhe organização nem id.
 *
 * Concorrência (duas sessões ao mesmo tempo) fica fora: este transporte é uma
 * sessão por vez. Quem cobre é o duplo clique do roteiro da prova de tela.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "09112000-0000-4000-8000-000000000001";
const ORG_B = "09112000-0000-4000-8000-000000000002";
const ATENDENTE_A = "09112000-1111-4000-8000-000000000001";
const LEITOR_A = "09112000-1111-4000-8000-000000000002";
const ATENDENTE_B = "09112000-1111-4000-8000-000000000003";
const FUNIL_A = "09112000-2222-4000-8000-000000000001";
const ETAPA_A = "09112000-3333-4000-8000-000000000001";
const NEGOCIO_NOVO = "09112000-4444-4000-8000-000000000001";
const NEGOCIO_DE_VIZINHO = "09112000-4444-4000-8000-000000000002";
const NEGOCIO_FONE_REPETIDO = "09112000-4444-4000-8000-000000000003";
const CONTATO_FORJADO = "09112000-5555-4000-8000-000000000001";
const FONE_REPETIDO = "+5541991120001";

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

/** Papel `authenticated` + claims: o caminho exato do PostgREST. */
function chamar(usuario: string, org: string, negocio: string, contato: object): string {
  return valor(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
    select public.fn_create_contact_for_lead(
      '${org}', '${negocio}', '${JSON.stringify(contato)}'::jsonb
    );
  `);
}

function recusa(usuario: string, org: string, negocio: string, contato: object): string {
  try {
    chamar(usuario, org, negocio, contato);
  } catch (err) {
    return motivoDoErro(err);
  }
  throw new Error("a função deveria ter recusado e não recusou");
}

const contatosDaOrg = (org: string) =>
  Number(valor(`select count(*) from public.contacts where organization_id = '${org}'`));
const vinculoDo = (negocio: string) =>
  valor(`select coalesce(contact_id::text, 'sem') from public.crm_leads where id = '${negocio}'`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ATENDENTE_A}', 'contato-9112-agent-a@invariant.test'),
      ('${LEITOR_A}',    'contato-9112-viewer-a@invariant.test'),
      ('${ATENDENTE_B}', 'contato-9112-agent-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'contato-9112-a', 'Contato 9112 A', 'Contato 9112 A'),
      ('${ORG_B}', 'contato-9112-b', 'Contato 9112 B', 'Contato 9112 B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ATENDENTE_A}', '${ORG_A}', 'agent',  now()),
      ('${LEITOR_A}',    '${ORG_A}', 'viewer', now()),
      ('${ATENDENTE_B}', '${ORG_B}', 'agent',  now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${FUNIL_A}', '${ORG_A}', 'Funil 9112', 'funil-9112') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA_A}', '${ORG_A}', '${FUNIL_A}', 'Entrada', 'entrada', 1) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values
      ('${NEGOCIO_NOVO}',          '${ORG_A}', '${FUNIL_A}', '${ETAPA_A}', 'Novo'),
      ('${NEGOCIO_DE_VIZINHO}',    '${ORG_A}', '${FUNIL_A}', '${ETAPA_A}', 'Vizinho'),
      ('${NEGOCIO_FONE_REPETIDO}', '${ORG_A}', '${FUNIL_A}', '${ETAPA_A}', 'Fone repetido')
      on conflict do nothing;
    insert into public.contacts (organization_id, name, phone_number) values
      ('${ORG_A}', 'Quem já tem o telefone', '${FONE_REPETIDO}') on conflict do nothing;
  `);
});

describe("fn_create_contact_for_lead", () => {
  it("grava endereço e campos configurados e vincula; o JSON não escolhe organização nem id", () => {
    const saida = JSON.parse(
      chamar(ATENDENTE_A, ORG_A, NEGOCIO_NOVO, {
        id: CONTATO_FORJADO,
        organization_id: ORG_B,
        name: "Maria",
        zip_code: "80000-000",
        street: "Rua XV",
        number: "10",
        city: "Curitiba",
        state: "PR",
        source: "manual",
        custom_fields: { preferencia: "Manha" },
      }),
    ) as { id: string; organization_id: string; cpf_available: boolean };

    expect(saida.id).not.toBe(CONTATO_FORJADO);
    expect(saida.organization_id).toBe(ORG_A);
    // A ficha da API (#4225): só o sinal de CPF, nenhuma coluna de CPF.
    expect(saida).not.toHaveProperty("cpf_encrypted");
    expect(saida).not.toHaveProperty("cpf_hash");
    expect(saida.cpf_available).toBe(false);
    expect(vinculoDo(NEGOCIO_NOVO)).toBe(saida.id);
    expect(
      valor(`select concat_ws('|', organization_id, zip_code, street, number, city, state,
               custom_fields->>'preferencia', created_by_user_id)
             from public.contacts where id = '${saida.id}'`),
    ).toBe(`${ORG_A}|80000-000|Rua XV|10|Curitiba|PR|Manha|${ATENDENTE_A}`);
  });

  it("negócio já vinculado recusa e não cria segundo contato", () => {
    const antes = contatosDaOrg(ORG_A);
    expect(recusa(ATENDENTE_A, ORG_A, NEGOCIO_NOVO, { name: "De novo" })).toContain("already_linked");
    expect(contatosDaOrg(ORG_A)).toBe(antes);
  });

  it("telefone de contato vivo recusa, e nem o contato nem o vínculo ficam pela metade", () => {
    const antes = contatosDaOrg(ORG_A);
    expect(
      recusa(ATENDENTE_A, ORG_A, NEGOCIO_FONE_REPETIDO, { name: "Outra", phone_number: FONE_REPETIDO }),
    ).toContain("uniq_contacts_org_phone");
    expect(contatosDaOrg(ORG_A)).toBe(antes);
    expect(vinculoDo(NEGOCIO_FONE_REPETIDO)).toBe("sem");
  });

  it("outra empresa não alcança o negócio, por nenhum dos dois lados", () => {
    const antesA = contatosDaOrg(ORG_A);
    const antesB = contatosDaOrg(ORG_B);
    expect(recusa(ATENDENTE_B, ORG_A, NEGOCIO_DE_VIZINHO, { name: "Intruso" })).toContain("forbidden");
    expect(recusa(ATENDENTE_B, ORG_B, NEGOCIO_DE_VIZINHO, { name: "Intruso" })).toContain("not_found");
    expect(contatosDaOrg(ORG_A)).toBe(antesA);
    expect(contatosDaOrg(ORG_B)).toBe(antesB);
    expect(vinculoDo(NEGOCIO_DE_VIZINHO)).toBe("sem");
  });

  it("viewer não cria", () => {
    expect(recusa(LEITOR_A, ORG_A, NEGOCIO_DE_VIZINHO, { name: "Leitura" })).toContain("forbidden");
    expect(vinculoDo(NEGOCIO_DE_VIZINHO)).toBe("sem");
  });

  it("anon não tem EXECUTE", () => {
    expect(
      valor(`select has_function_privilege('anon',
        'public.fn_create_contact_for_lead(uuid, uuid, jsonb)', 'execute')`),
    ).toMatch(/^(f|false)$/);
  });
});
