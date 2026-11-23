import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * #4852 / doc de decisão 400 — O HISTÓRICO QUE SOBREVIVE AO NEGÓCIO CONTINUA AO
 * ALCANCE DA ANONIMIZAÇÃO.
 *
 * A migration 9466 troca `crm_lead_activities.lead_id` de `ON DELETE CASCADE`
 * para `ON DELETE SET NULL`. A anonimização (`fn_lgpd_cascade_redact_contact`)
 * acha o histórico pelo CONTATO ou pelo NEGÓCIO; com o negócio apagado só o
 * contato sobra. Uma linha sem `contact_id` ficaria, então, para sempre fora do
 * alcance dela — legível depois de o titular ser anonimizado.
 *
 * As duas guardas medidas aqui:
 *   1. a linha COM contato sobrevive ao negócio e é redigida quando o contato é
 *      anonimizado (é o "histórico preservado" que a B promete);
 *   2. a linha SEM contato é apagada junto com o negócio
 *      (`trg_crm_leads_apaga_historico_sem_contato`), como o CASCADE fazia —
 *      vale também para o negócio que nunca teve contato;
 *   3. o negócio sai primeiro e o CONTATO é apagado depois: a FK do contato é
 *      `ON DELETE SET NULL`, e a linha ficaria sem negócio e sem contato. Ela sai
 *      junto com o contato (`trg_contacts_apaga_historico_sem_negocio`).
 *
 * Sabotagem (medida no PR): sem o gatilho de `crm_leads`, (2) fica vermelho com a
 * linha órfã legível depois da anonimização; sem o de `contacts`, (3) fica
 * vermelho com a linha sem negócio e sem contato ainda na tabela.
 *
 * Namespace 9f43.
 */

const ORG = "9f430001-0000-4000-8000-000000000000";
const PIPE = "9f430002-0000-4000-8000-000000000001";
const ETAPA = "9f430003-0000-4000-8000-000000000001";
const CONTATO = "9f430004-0000-4000-8000-000000000001";
const LEAD_COM_CONTATO = "9f430005-0000-4000-8000-000000000001";
const LEAD_SEM_CONTATO = "9f430005-0000-4000-8000-000000000002";
const COM_CONTATO = "9f430006-0000-4000-8000-000000000001";
const SEM_CONTATO_DO_NEGOCIO_COM_CONTATO = "9f430006-0000-4000-8000-000000000002";
const DO_NEGOCIO_SEM_CONTATO = "9f430006-0000-4000-8000-000000000003";
// Caso 3: o negócio sai antes, o contato sai depois.
const CONTATO_APAGADO = "9f430004-0000-4000-8000-000000000002";
const LEAD_DO_CONTATO_APAGADO = "9f430005-0000-4000-8000-000000000003";
const DO_CONTATO_APAGADO = "9f430006-0000-4000-8000-000000000004";

const TODAS = [COM_CONTATO, SEM_CONTATO_DO_NEGOCIO_COM_CONTATO, DO_NEGOCIO_SEM_CONTATO]
  .map((id) => `'${id}'`)
  .join(", ");

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-9f43', 'Inv 9f43', 'Inv 9f43')
      on conflict (id) do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug, position)
      values ('${PIPE}', '${ORG}', 'Funil', 'funil-9f43', 1000)
      on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA}', '${ORG}', '${PIPE}', 'Novo', 'novo-9f43', 1000)
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name) values
      ('${CONTATO}', '${ORG}', 'Maria Silva'),
      ('${CONTATO_APAGADO}', '${ORG}', 'João Souza')
      on conflict (id) do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values
      ('${LEAD_COM_CONTATO}', '${ORG}', '${PIPE}', '${ETAPA}', 'Negócio da Maria', '${CONTATO}'),
      ('${LEAD_SEM_CONTATO}', '${ORG}', '${PIPE}', '${ETAPA}', 'Negócio sem ficha', null),
      ('${LEAD_DO_CONTATO_APAGADO}', '${ORG}', '${PIPE}', '${ETAPA}', 'Negócio do João', '${CONTATO_APAGADO}')
      on conflict (id) do nothing;

    -- Três linhas legíveis: a que leva o contato, a de um emissor que gravou sem
    -- ele (o caso que a 9466 fecha) e a de um negócio que nunca teve contato.
    insert into public.crm_lead_activities
      (id, organization_id, lead_id, contact_id, type, source_module, reason, payload) values
      ('${COM_CONTATO}', '${ORG}', '${LEAD_COM_CONTATO}', '${CONTATO}', 'stage_changed', 'crm',
       'Maria pediu orçamento', '{"nota":"Maria Silva"}'::jsonb),
      ('${SEM_CONTATO_DO_NEGOCIO_COM_CONTATO}', '${ORG}', '${LEAD_COM_CONTATO}', null, 'document_attached',
       'leads/attachments', 'Documento anexado: RG da Maria', '{"file_name":"rg-maria.pdf"}'::jsonb),
      ('${DO_NEGOCIO_SEM_CONTATO}', '${ORG}', '${LEAD_SEM_CONTATO}', null, 'stage_changed', 'crm',
       'Movido de Novo para Ganho', '{"nota":"cliente sem ficha"}'::jsonb),
      ('${DO_CONTATO_APAGADO}', '${ORG}', '${LEAD_DO_CONTATO_APAGADO}', '${CONTATO_APAGADO}', 'stage_changed', 'crm',
       'João pediu desconto', '{"nota":"João Souza"}'::jsonb)
      on conflict (id) do nothing;
  `);
});

describe("histórico do negócio apagado e a anonimização (#4852, doc 400)", () => {
  it("ANTES: as três linhas existem e são legíveis (controle positivo)", () => {
    expect(
      lastLine(sql(`select count(*) from public.crm_lead_activities where id in (${TODAS}) and reason is not null;`)),
    ).toBe("3");
  });

  it("apagar o negócio deixa a linha COM contato e apaga as SEM contato", () => {
    sql(`delete from public.crm_leads where id in ('${LEAD_COM_CONTATO}', '${LEAD_SEM_CONTATO}');`);

    const sobrou = sql(`
      select id::text || '|' || (lead_id is null)::text
        from public.crm_lead_activities where id in (${TODAS}) order by id;
    `);
    // Só a linha com contato sobrevive, sem o negócio.
    expect(sobrou).toBe(`${COM_CONTATO}|true`);
  });

  it("anonimizar o contato não deixa NENHUMA linha do negócio apagado legível", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${CONTATO}', gen_random_uuid());`);

    const legiveis = lastLine(
      sql(`
        select count(*) from public.crm_lead_activities
         where id in (${TODAS})
           and (reason is not null or payload <> '{}'::jsonb);
      `),
    );
    expect(legiveis).toBe("0");

    // O histórico continua lá — redigido, não apagado (é a promessa da B).
    expect(
      lastLine(sql(`select count(*) from public.crm_lead_activities where id = '${COM_CONTATO}';`)),
    ).toBe("1");
  });

  it("apaga o negócio, depois apaga o contato → 0 linhas dele em crm_lead_activities", () => {
    sql(`delete from public.crm_leads where id = '${LEAD_DO_CONTATO_APAGADO}';`);

    // Controle: depois do negócio, a linha segue lá, só com o contato.
    expect(
      sql(`
        select (lead_id is null)::text || '|' || contact_id::text
          from public.crm_lead_activities where id = '${DO_CONTATO_APAGADO}';
      `),
    ).toBe(`true|${CONTATO_APAGADO}`);

    // O caminho da tela (DELETE /api/v1/contacts/[id]).
    expect(
      lastLine(sql(`select public.fn_apagar_contato_com_historico('${CONTATO_APAGADO}', '${ORG}');`)),
    ).toBe("t");

    expect(
      lastLine(sql(`select count(*) from public.crm_lead_activities where id = '${DO_CONTATO_APAGADO}';`)),
    ).toBe("0");
  });
});
