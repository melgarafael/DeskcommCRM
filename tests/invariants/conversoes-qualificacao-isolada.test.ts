import { beforeAll, describe, expect, it } from "vitest";
import { GOV_ORG, GOV_STAGE, GOV_LEAD, seedGov, sql } from "./gov-helpers";

beforeAll(seedGov);
describe("captura e qualificação: contrato do banco", () => {
  it("grava clique wbraid sem fabricar gclid", () => {
    expect(
      sql(`begin;
      insert into public.google_ads_click_refs(organization_id,token,wbraid) values ('${GOV_ORG}','2ABCDE','wbraid-teste');
      select gclid is null, wbraid from public.google_ads_click_refs where organization_id='${GOV_ORG}' and token='2ABCDE';
      rollback;`),
    ).toContain("t|wbraid-teste");
  });
  it("a captura nova sem identificador é recusada", () => {
    expect(() =>
      sql(
        `insert into public.google_ads_click_refs(organization_id,token) values ('${GOV_ORG}','2ABCDE');`,
      ),
    ).toThrow(/google_click_tem_identificador/);
  });
  it("a configuração não aceita etapa de outra organização", () => {
    expect(() =>
      sql(`begin;
      insert into public.organizations(id,slug,legal_name,display_name) values ('99999999-9999-4999-8999-999999999999','org-qualificacao','Outra','Outra');
      insert into public.ad_platform_connections(organization_id,platform,google_qualification_stage_id)
      values ('99999999-9999-4999-8999-999999999999','google_ads','${GOV_STAGE}');
      rollback;`),
    ).toThrow(/ad_qualification_stage_org_fk/);
  });
  it("grava data da configuração e não a altera ao salvar a mesma regra", () => {
    expect(
      sql(`begin;
      insert into public.ad_platform_connections(organization_id,platform,google_qualification_stage_id,google_qualification_action_id)
      values ('${GOV_ORG}','google_ads','${GOV_STAGE}','42')
      on conflict (organization_id,platform) do update set google_qualification_stage_id='${GOV_STAGE}',google_qualification_action_id='42';
      update public.ad_platform_connections set google_qualification_configured_at='2000-01-01'
        where organization_id='${GOV_ORG}' and platform='google_ads';
      select google_qualification_configured_at=now() from public.ad_platform_connections where organization_id='${GOV_ORG}' and platform='google_ads';
      rollback;`),
    ).toContain("t");
  });
  it("snapshot e reprocessamento de qualificação preservam ação/data e isolam organização", () => {
    expect(
      sql(`begin;
      insert into public.ad_conversion_dispatches(organization_id,lead_id,platform,event_name,status,event_occurred_at,google_action_id)
      values ('${GOV_ORG}','${GOV_LEAD}','google_ads','QualifiedLead','error','2026-09-24T01:00:00Z','42');
      update public.ad_conversion_dispatches set event_occurred_at=now(),google_action_id='99'
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}' and event_name='QualifiedLead';
      select google_action_id, event_occurred_at='2026-09-24T01:00:00Z' from public.ad_conversion_dispatches
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}' and event_name='QualifiedLead';
      select public.fn_solicitar_reenvio_conversao('99999999-9999-4999-8999-999999999999','${GOV_LEAD}','QualifiedLead');
      select public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}','QualifiedLead');
      select public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}','QualifiedLead');
      select payload->>'event_name' from public.event_log where organization_id='${GOV_ORG}' and entity_id='${GOV_LEAD}' and event_type='ad_conversion.retry_requested';
      rollback;`),
    ).toContain("42|t\nf\nt\nf\nQualifiedLead");
  });
  it("a nova RPC continua inacessível aos papéis do navegador", () => {
    expect(
      sql(`select has_function_privilege('anon','public.fn_solicitar_reenvio_conversao(uuid,uuid,text)','execute'),
      has_function_privilege('authenticated','public.fn_solicitar_reenvio_conversao(uuid,uuid,text)','execute'),
      has_table_privilege('authenticated','public.google_ads_click_refs','select');`),
    ).toBe("f|f|f");
  });
});
