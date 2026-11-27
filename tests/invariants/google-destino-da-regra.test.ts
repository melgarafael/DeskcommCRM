import { beforeAll, describe, expect, it } from "vitest";
import { GOV_LEAD, GOV_ORG, GOV_STAGE, seedGov, sql } from "./gov-helpers";

beforeAll(seedGov);

const regras = `begin;
  delete from public.google_ads_conversion_rules where organization_id='${GOV_ORG}';`;
const recibo = `begin;
  delete from public.ad_conversion_dispatches where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';`;

describe("destino de conversão Google por regra", () => {
  it("duas contas compartilham etapa e evento, com upsert independente inclusive na regra global", () => {
    const out = sql(`${regras}
      insert into public.google_ads_conversion_rules
        (organization_id,stage_id,event_name,label,google_action_id,google_customer_id)
      values
        ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Conta A','41','1111111111'),
        ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Conta B','42','2222222222'),
        ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Global','43',null);
      insert into public.google_ads_conversion_rules
        (organization_id,stage_id,event_name,label,google_action_id,google_customer_id)
      values ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Global editada','44',null)
      on conflict (organization_id,stage_id,google_customer_id) do update
        set label=excluded.label, google_action_id=excluded.google_action_id;
      select count(*),count(distinct event_name),max(google_action_id) filter(where google_customer_id is null)
        from public.google_ads_conversion_rules where organization_id='${GOV_ORG}';
      rollback;`);
    expect(out).toContain("3|1|44");
  });

  it.each(["'1111111111'", "null"])("recusa conta repetida na mesma etapa (%s)", (conta) => {
    expect(() =>
      sql(`${regras}
      insert into public.google_ads_conversion_rules
        (organization_id,stage_id,event_name,label,google_action_id,google_customer_id)
      values
        ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Primeira','41',${conta}),
        ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Repetida','42',${conta});
      rollback;`),
    ).toThrow(/google_ads_conversion_rules_org_stage_customer_uk/);
  });

  it("trocar conta ou MCC reinicia a trava temporal; editar nome preserva o carimbo", () => {
    const out = sql(`${regras}
      insert into public.google_ads_conversion_rules
        (organization_id,stage_id,event_name,label,google_action_id,google_customer_id,configured_at)
      values ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Teste','41','1111111111','2020-01-01');
      update public.google_ads_conversion_rules set label='Outro nome'
        where organization_id='${GOV_ORG}' and stage_id='${GOV_STAGE}';
      select 'nome:' || (configured_at='2020-01-01')::text from public.google_ads_conversion_rules
        where organization_id='${GOV_ORG}' and stage_id='${GOV_STAGE}';
      update public.google_ads_conversion_rules set google_customer_id='2222222222'
        where organization_id='${GOV_ORG}' and stage_id='${GOV_STAGE}';
      select 'conta:' || (configured_at>'2020-01-01')::text from public.google_ads_conversion_rules
        where organization_id='${GOV_ORG}' and stage_id='${GOV_STAGE}';
      delete from public.google_ads_conversion_rules where organization_id='${GOV_ORG}';
      insert into public.google_ads_conversion_rules
        (organization_id,stage_id,event_name,label,google_action_id,google_customer_id,configured_at)
      values ('${GOV_ORG}','${GOV_STAGE}','QualifiedLead','Teste','41','1111111111','2020-01-01');
      update public.google_ads_conversion_rules set google_login_customer_id='9999999999'
        where organization_id='${GOV_ORG}' and stage_id='${GOV_STAGE}';
      select 'mcc:' || (configured_at>'2020-01-01')::text from public.google_ads_conversion_rules
        where organization_id='${GOV_ORG}' and stage_id='${GOV_STAGE}';
      rollback;`);
    expect(out).toContain("nome:true");
    expect(out).toContain("conta:true");
    expect(out).toContain("mcc:true");
  });

  it("o primeiro retrato preserva conta, MCC nula, API, política, data e ação", () => {
    const out = sql(`${recibo}
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,event_occurred_at,google_action_id,
         google_customer_id,google_login_customer_id,google_api,google_destination_explicit,remote_request_id)
      values ('${GOV_ORG}','${GOV_LEAD}','google_ads','QualifiedLead','skipped','2020-01-01','41',
        '1111111111',null,'data_manager',true,'protocolo-original');
      update public.ad_conversion_dispatches set
        google_customer_id='2222222222',google_login_customer_id='9999999999',google_api='google_ads',
        google_destination_explicit=false,event_occurred_at='2021-01-01',google_action_id='42'
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      select google_customer_id,google_login_customer_id is null,google_api,google_destination_explicit,
        event_occurred_at='2020-01-01',google_action_id
        from public.ad_conversion_dispatches where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      rollback;`);
    expect(out).toContain("1111111111|t|data_manager|t|t|41");
  });

  it("destino conhecido sem credencial congela a identidade e aceita a primeira API uma única vez", () => {
    const out = sql(`${recibo}
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,google_customer_id,google_destination_explicit)
      values ('${GOV_ORG}','${GOV_LEAD}','google_ads','QualifiedLead','skipped','1111111111',true);
      select 'sem_api:' || (google_api is null)::text from public.ad_conversion_dispatches
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      update public.ad_conversion_dispatches set google_customer_id='2222222222',
        google_login_customer_id='9999999999',google_api='google_ads',google_destination_explicit=false
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      update public.ad_conversion_dispatches set google_api='data_manager'
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      select google_customer_id,google_login_customer_id is null,google_api,google_destination_explicit
        from public.ad_conversion_dispatches where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      rollback;`);
    expect(out).toContain("sem_api:true");
    expect(out).toContain("1111111111|t|google_ads|t");
  });

  it("protocolo legado sem retrato não ganha um destino presumido", () => {
    const out = sql(`${recibo}
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,remote_request_id)
      values ('${GOV_ORG}','${GOV_LEAD}','google_ads','QualifiedLead','skipped','legado');
      update public.ad_conversion_dispatches set google_customer_id='2222222222',
        google_api='data_manager',google_destination_explicit=true
        where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      select google_customer_id is null,google_login_customer_id is null,
        google_api is null,google_destination_explicit is null,remote_request_id
        from public.ad_conversion_dispatches where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      rollback;`);
    expect(out).toContain("t|t|t|t|legado");
  });

  it("os novos campos continuam privados e recusam um retrato parcial", () => {
    expect(
      sql(`select
      has_table_privilege('authenticated','public.google_ads_conversion_rules','select'),
      has_table_privilege('anon','public.ad_conversion_dispatches','select'),
      has_table_privilege('service_role','public.google_ads_conversion_rules','update');`),
    ).toBe("f|f|t");
    expect(() =>
      sql(`${recibo}
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,google_customer_id)
      values ('${GOV_ORG}','${GOV_LEAD}','google_ads','QualifiedLead','skipped','1111111111');
      rollback;`),
    ).toThrow(/ad_conversion_dispatches_google_destination_check/);
  });
});
