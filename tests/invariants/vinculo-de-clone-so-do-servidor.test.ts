import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

/**
 * O VÍNCULO DE CLONE DO CARD SÓ É GRAVADO PELO SERVIDOR (migration 9389).
 *
 * `source_metadata.clonado_de` e `source_metadata.movido_para` ligam o card de
 * origem à continuação dele em outro funil, e a ação `create_or_move_lead`
 * reconhece a continuação por `clonado_de`. O gatilho
 * `trg_guard_vinculo_de_clone_do_lead` reserva as duas chaves ao servidor, como
 * a `meta_capi_lead_birth_v1`: a sessão (`authenticated`) não cria card com elas
 * nem muda o valor delas; o resto de `source_metadata` segue editável.
 *
 * Os casos rodam pelo papel e pelas claims que o PostgREST usa, num card do
 * PRÓPRIO agente — onde a RLS deixa escrever. Por isso o controle (b) importa:
 * ele prova que a recusa em (a) é do gatilho, não da política.
 *
 * Comando:
 *     pnpm test:db tests/invariants/vinculo-de-clone-so-do-servidor.test.ts
 */

const CARD_DO_AGENTE = "93890000-0000-4000-8000-000000000001";
const CARD_CLONADO = "93890000-0000-4000-8000-000000000002";
const CARD_NOVO = "93890000-0000-4000-8000-000000000003";
const ORIGEM_ALHEIA = "93890000-0000-4000-8000-0000000000ff";

/** Roda `dml` como o agente pela sessão; devolve a mensagem de erro, ou null se passou. */
function comoAgente(dml: string): string | null {
  return tentar(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}","role":"authenticated"}', false);
    ${dml};
  `);
}

function comoServidor(dml: string): string | null {
  return tentar(`set role service_role; ${dml};`);
}

function tentar(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (erro) {
    return (erro as { stderr?: string }).stderr ?? String(erro);
  }
}

function metadados(id: string): Record<string, unknown> {
  return JSON.parse(sql(`select source_metadata from public.crm_leads where id = '${id}';`)) as Record<
    string,
    unknown
  >;
}

const VINCULO = `{"lead_id":"${ORIGEM_ALHEIA}","pipeline_id":"${GOV_PIPELINE}"}`;

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_kind, source_metadata)
      values ('${CARD_DO_AGENTE}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Card do agente', '${GOV_AGENT_A}', 'user', '{"canal":"whatsapp"}'),
             ('${CARD_CLONADO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Clone legítimo', '${GOV_AGENT_A}', 'user',
              '{"canal":"whatsapp","clonado_de":${VINCULO}}')
      on conflict (id) do nothing;
  `);
});

describe("chaves de clone reservadas ao servidor (9389)", () => {
  it("(a) a sessão não grava `clonado_de` num card próprio — nem no UPDATE, nem no INSERT", () => {
    const noUpdate = comoAgente(
      `update public.crm_leads set source_metadata = source_metadata || '{"clonado_de":${VINCULO}}'::jsonb
        where id = '${CARD_DO_AGENTE}'`,
    );
    expect(noUpdate).toContain("crm_lead_clone_link_reserved");
    expect(metadados(CARD_DO_AGENTE)).not.toHaveProperty("clonado_de");

    const noInsert = comoAgente(
      `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_kind, source_metadata)
         values ('${CARD_NOVO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Card novo', '${GOV_AGENT_A}', 'user',
                 '{"clonado_de":${VINCULO}}')`,
    );
    expect(noInsert).toContain("crm_lead_clone_link_reserved");
    expect(sql(`select count(*) from public.crm_leads where id = '${CARD_NOVO}';`)).toBe("0");
  });

  it("(a) a sessão não muda nem apaga o vínculo que o servidor gravou, e não grava `movido_para`", () => {
    expect(
      comoAgente(
        `update public.crm_leads set source_metadata = jsonb_set(source_metadata, '{clonado_de,lead_id}', '"${CARD_DO_AGENTE}"')
          where id = '${CARD_CLONADO}'`,
      ),
    ).toContain("crm_lead_clone_link_reserved");
    expect(
      comoAgente(`update public.crm_leads set source_metadata = source_metadata - 'clonado_de' where id = '${CARD_CLONADO}'`),
    ).toContain("crm_lead_clone_link_reserved");
    expect(
      comoAgente(
        `update public.crm_leads set source_metadata = source_metadata || '{"movido_para":{"lead_id":"${CARD_CLONADO}"}}'::jsonb
          where id = '${CARD_DO_AGENTE}'`,
      ),
    ).toContain("crm_lead_clone_link_reserved");
    expect((metadados(CARD_CLONADO).clonado_de as { lead_id: string }).lead_id).toBe(ORIGEM_ALHEIA);
  });

  it("(b) a mesma sessão edita as OUTRAS chaves de `source_metadata` — inclusive no card que tem o vínculo", () => {
    expect(
      comoAgente(
        `update public.crm_leads set source_metadata = source_metadata || '{"utm_campaign":"inverno"}'::jsonb
          where id = '${CARD_DO_AGENTE}'`,
      ),
    ).toBeNull();
    expect(metadados(CARD_DO_AGENTE).utm_campaign).toBe("inverno");

    // Reenviar o vínculo SEM mudá-lo não é escrever o vínculo.
    expect(
      comoAgente(
        `update public.crm_leads set source_metadata = source_metadata || '{"utm_campaign":"verao"}'::jsonb
          where id = '${CARD_CLONADO}'`,
      ),
    ).toBeNull();
    expect(metadados(CARD_CLONADO)).toMatchObject({ utm_campaign: "verao", clonado_de: { lead_id: ORIGEM_ALHEIA } });
  });

  it("(c) o servidor grava `clonado_de` e `movido_para` — service_role e o dono das funções do sistema", () => {
    expect(
      comoServidor(
        `update public.crm_leads set source_metadata = source_metadata || '{"clonado_de":${VINCULO}}'::jsonb
          where id = '${CARD_DO_AGENTE}' and organization_id = '${GOV_ORG}'`,
      ),
    ).toBeNull();
    expect((metadados(CARD_DO_AGENTE).clonado_de as { lead_id: string }).lead_id).toBe(ORIGEM_ALHEIA);

    // `postgres` é quem é o `current_user` dentro das funções `security definer`
    // (a cascata de LGPD zera `source_metadata` inteiro por esse caminho).
    expect(
      tentar(
        `update public.crm_leads set source_metadata = source_metadata || '{"movido_para":{"lead_id":"${CARD_CLONADO}"}}'::jsonb
          where id = '${CARD_DO_AGENTE}'`,
      ),
    ).toBeNull();
    expect(metadados(CARD_DO_AGENTE)).toHaveProperty("movido_para");
  });

  it("(e) o INSERT do clone, sem o vínculo, segue decidido pela policy: modo 'só os meus' recusa o card sem dono, aceita o do próprio agente", () => {
    // É o INSERT que a rota `/clone` faz pela sessão (o vínculo entra depois,
    // pelo serviço). O dono herdado DESCARTADO vira card sem dono — e no modo
    // `own` a `crm_leads_insert` não deixa o agente criá-lo.
    const SEM_DONO = "93890000-0000-4000-8000-000000000004";
    const DO_AGENTE = "93890000-0000-4000-8000-000000000005";
    sql(`update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"own"}'::jsonb
          where id = '${GOV_ORG}';`);
    try {
      const semDono = comoAgente(
        `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, source_metadata)
           values ('${SEM_DONO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Clone sem dono', '{"canal":"whatsapp"}')`,
      );
      expect(semDono).toContain("row-level security");
      expect(sql(`select count(*) from public.crm_leads where id = '${SEM_DONO}';`)).toBe("0");

      expect(
        comoAgente(
          `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_kind, source_metadata)
             values ('${DO_AGENTE}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Clone do agente', '${GOV_AGENT_A}', 'user', '{"canal":"whatsapp"}')`,
        ),
      ).toBeNull();
      // …e o vínculo, gravado em seguida pelo servidor, passa no card que a policy aceitou.
      expect(
        comoServidor(
          `update public.crm_leads set source_metadata = source_metadata || '{"clonado_de":${VINCULO}}'::jsonb
            where id = '${DO_AGENTE}' and organization_id = '${GOV_ORG}'`,
        ),
      ).toBeNull();
      expect((metadados(DO_AGENTE).clonado_de as { lead_id: string }).lead_id).toBe(ORIGEM_ALHEIA);
    } finally {
      sql(`update public.organizations set settings = settings - 'visibility_mode' where id = '${GOV_ORG}';`);
    }
  });

  it("a função do gatilho não é chamável por anon nem pela sessão", () => {
    expect(
      sql(`select has_function_privilege('anon', 'public.fn_guard_vinculo_de_clone_do_lead()', 'execute')::text
              || ':' || has_function_privilege('authenticated', 'public.fn_guard_vinculo_de_clone_do_lead()', 'execute')::text;`),
    ).toBe("false:false");
  });

  it("baseline e migration trazem o mesmo bloco", () => {
    const corpo = (arquivo: string): string => {
      const texto = readFileSync(join(process.cwd(), "supabase", ...arquivo.split("/")), "utf8");
      const inicio = texto.indexOf("create or replace function public.fn_guard_vinculo_de_clone_do_lead");
      const fim = texto.indexOf("execute function public.fn_guard_vinculo_de_clone_do_lead();", inicio);
      expect(inicio, `bloco ausente em ${arquivo}`).toBeGreaterThan(-1);
      expect(fim, `gatilho ausente em ${arquivo}`).toBeGreaterThan(inicio);
      return texto.slice(inicio, fim);
    };
    expect(corpo("baseline.sql")).toBe(
      corpo("migrations/20261115075848_9389_chaves_de_clone_reservadas_ao_servidor.sql"),
    );
  });
});
