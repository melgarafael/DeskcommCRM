/**
 * A PLANILHA DE PROSPECÇÃO NÃO CRUZA ORGANIZAÇÃO E NÃO TRAZ DE VOLTA QUEM FOI EXCLUÍDO.
 *
 * `importarPlanilha` (lib/prospecting/store.ts) grava cada linha da planilha com o MESMO
 * `insert ... on conflict do nothing` da busca no Google Maps, usando `planilha:<E.164>`
 * como `place_id`. Duas coisas decidem se isso é seguro, e as duas moram no banco:
 *
 *   1. A unicidade é POR ORGANIZAÇÃO (`unique (organization_id, place_id)` e o índice
 *      `prospecting_phone_once_org`). Se fosse global, a lista de um cliente pagante
 *      perderia empresas porque OUTRO cliente já as tinha — e a recusa revelaria que o
 *      outro as tem. Se faltasse, repetir o envio duplicaria a fila.
 *   2. O gatilho `prospecting_refuse_erased` recusa, em silêncio, o telefone de quem foi
 *      anonimizado — mesmo que a planilha o traga com outro `place_id`.
 *
 * Este arquivo exercita o SQL do baseline, não a rota (a rota é coberta por teste de unidade).
 * Cada `sql()` é uma sessão; contamos as linhas que de fato entraram com `returning`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/** Namespace próprio (30300000-): semente idempotente e sem colisão em paralelo. */
const ORG_A = "30300000-0000-4000-8000-00000000000a";
const ORG_B = "30300000-0000-4000-8000-00000000000b";
const CAMPANHA_A = "30300000-1111-4000-8000-00000000000a";
const CAMPANHA_B = "30300000-1111-4000-8000-00000000000b";
const FONE_COMPARTILHADO = "+5511999990001";
const FONE_ANONIMIZADO = "+5511988880002";
const FONE_NOVO = "+5511977770003";

function valor(consulta: string): string {
  return sql(consulta).split("\n").at(-1) ?? "";
}

/** O insert de `gravarCandidatos`, sem tirar nem pôr; devolve quantas linhas ENTRARAM. */
function inserirPlanilha(org: string, campanha: string, placeId: string, telefone: string): number {
  return Number(
    valor(`
      with ins as (
        insert into public.prospecting_candidates(organization_id,campaign_id,place_id,phone,data)
        values ('${org}','${campanha}','${placeId}','${telefone}',
          jsonb_build_object('key','${placeId}','name','Empresa da planilha','phone','${telefone}'))
        on conflict do nothing
        returning 1
      )
      select count(*) from ins;
    `),
  );
}

function candidatosDoTelefone(org: string, telefone: string): number {
  return Number(
    valor(
      `select count(*) from public.prospecting_candidates where organization_id = '${org}' and phone = '${telefone}';`,
    ),
  );
}

beforeAll(() => {
  sql(`
    set search_path = public, extensions, pg_temp;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'planilha-a-0303', 'Planilha A', 'Planilha A'),
      ('${ORG_B}', 'planilha-b-0303', 'Planilha B', 'Planilha B')
      on conflict do nothing;

    insert into public.prospecting_campaigns (id, organization_id, request_id, name, search, search_status) values
      ('${CAMPANHA_A}', '${ORG_A}', gen_random_uuid(), 'Planilha A', '{"origem":"planilha"}'::jsonb, 'succeeded'),
      ('${CAMPANHA_B}', '${ORG_B}', gen_random_uuid(), 'Planilha B', '{"origem":"planilha"}'::jsonb, 'succeeded')
      on conflict (id) do nothing;

    delete from public.prospecting_candidates where organization_id in ('${ORG_A}', '${ORG_B}');

    -- A empresa que a organização B já tem na lista dela.
    insert into public.prospecting_candidates (organization_id, campaign_id, place_id, phone, data)
      values ('${ORG_B}', '${CAMPANHA_B}', 'planilha:${FONE_COMPARTILHADO}', '${FONE_COMPARTILHADO}',
        jsonb_build_object('key','planilha:${FONE_COMPARTILHADO}','name','Empresa da B'));

    -- Quem foi anonimizado na A: o que a função de anonimização deixa (sal + HMACs; o
    -- telefone e o place_id originais somem).
    insert into public.prospecting_candidates (id, organization_id, campaign_id, place_id, phone, data)
      values ('30300000-3333-4000-8000-000000000001', '${ORG_A}', '${CAMPANHA_A}',
        'planilha:${FONE_ANONIMIZADO}', '${FONE_ANONIMIZADO}',
        jsonb_build_object('key','planilha:${FONE_ANONIMIZADO}','name','Quem pediu exclusão'));
    update public.prospecting_candidates
       set suppression_salt = gen_random_bytes(32)
     where id = '30300000-3333-4000-8000-000000000001';
    update public.prospecting_candidates
       set suppression_place = hmac(convert_to(place_id, 'UTF8'), suppression_salt, 'sha256'),
           suppression_phone = hmac(convert_to(phone, 'UTF8'), suppression_salt, 'sha256'),
           place_id = 'redacted:' || id,
           phone = null,
           data = '{}'::jsonb
     where id = '30300000-3333-4000-8000-000000000001';
  `);
});

describe("planilha de prospecção — isolamento entre organizações", () => {
  it("a pré-condição existe: a B tem o telefone e a A ainda não", () => {
    expect(candidatosDoTelefone(ORG_B, FONE_COMPARTILHADO)).toBe(1);
    expect(candidatosDoTelefone(ORG_A, FONE_COMPARTILHADO)).toBe(0);
  });

  it("o telefone que já é candidato na B ENTRA na A, e a B continua com uma só linha", () => {
    expect(inserirPlanilha(ORG_A, CAMPANHA_A, `planilha:${FONE_COMPARTILHADO}`, FONE_COMPARTILHADO)).toBe(1);
    expect(candidatosDoTelefone(ORG_A, FONE_COMPARTILHADO)).toBe(1);
    expect(candidatosDoTelefone(ORG_B, FONE_COMPARTILHADO)).toBe(1);
  });

  it("reenviar a mesma planilha na A não duplica: o segundo insert grava 0 linhas", () => {
    expect(inserirPlanilha(ORG_A, CAMPANHA_A, `planilha:${FONE_COMPARTILHADO}`, FONE_COMPARTILHADO)).toBe(0);
    expect(candidatosDoTelefone(ORG_A, FONE_COMPARTILHADO)).toBe(1);
  });
});

describe("planilha de prospecção — quem foi excluído a pedido do titular não volta", () => {
  it("controle: um telefone qualquer ainda entra na mesma organização (o 0 abaixo não é defeito do cenário)", () => {
    expect(inserirPlanilha(ORG_A, CAMPANHA_A, `planilha:${FONE_NOVO}`, FONE_NOVO)).toBe(1);
  });

  it("a semente está anonimizada: sem telefone legível e com a supressão de pé", () => {
    expect(
      valor(
        `select (phone is null and suppression_salt is not null and suppression_phone is not null)::text from public.prospecting_candidates where id = '30300000-3333-4000-8000-000000000001';`,
      ),
    ).toBe("true");
  });

  it("o mesmo telefone, com OUTRO place_id planilha:, é recusado pelo gatilho (0 linhas)", () => {
    expect(inserirPlanilha(ORG_A, CAMPANHA_A, "planilha:outra-grafia", FONE_ANONIMIZADO)).toBe(0);
    expect(candidatosDoTelefone(ORG_A, FONE_ANONIMIZADO)).toBe(0);
  });

  it("a supressão é da organização: na B o mesmo telefone ainda entra", () => {
    expect(inserirPlanilha(ORG_B, CAMPANHA_B, `planilha:${FONE_ANONIMIZADO}`, FONE_ANONIMIZADO)).toBe(1);
  });
});
