import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { GOV_LEAD, GOV_ORG, GOV_STAGE, seedGov, sql } from "./gov-helpers";
beforeAll(seedGov);
const migration = readFileSync(
  "supabase/migrations/20261002212525_0524_conversao_meta_por_etapa.sql",
  "utf8",
);
describe("regras da Meta por etapa (0524)", () => {
  it("browser não lê nem altera regras; service role mantém acesso", () => {
    expect(
      sql(
        "select has_table_privilege('anon','public.meta_ads_conversion_rules','select'),has_table_privilege('authenticated','public.meta_ads_conversion_rules','update'),has_table_privilege('service_role','public.meta_ads_conversion_rules','select');",
      ),
    ).toBe("f|f|t");
  });
  it("etapa de outra organização não pode receber regra", () => {
    expect(() =>
      sql(`begin;
  insert into public.organizations(id,slug,legal_name,display_name) values ('99999999-9999-4999-8999-999999999997','meta-rules-other','Outra','Outra');
  insert into public.meta_ads_conversion_rules(organization_id,stage_id,event_name,meta_event) values ('99999999-9999-4999-8999-999999999997','${GOV_STAGE}','MetaEtapa:${GOV_STAGE}','LeadSubmitted'); rollback;`),
    ).toThrow(/meta_ads_conversion_rules_stage_org_fk/);
  });
  it("evento fora da lista padrão e chave do Google são recusados", () => {
    expect(() =>
      sql(`begin;
  insert into public.meta_ads_conversion_rules(organization_id,stage_id,event_name,meta_event) values ('${GOV_ORG}','${GOV_STAGE}','MetaEtapa:${GOV_STAGE}','Comprou'); rollback;`),
    ).toThrow(/meta_ads_conversion_rules_evento_conhecido/);
    expect(() =>
      sql(`begin;
  insert into public.meta_ads_conversion_rules(organization_id,stage_id,event_name,meta_event) values ('${GOV_ORG}','${GOV_STAGE}','Etapa:${GOV_STAGE}','LeadSubmitted'); rollback;`),
    ).toThrow(/meta_ads_conversion_rules_evento_do_livro/);
  });
  it("trocar o evento reabre a trava; renomear nada não retroage; reaplicar não apaga", () => {
    const output = sql(`begin;
  delete from public.meta_ads_conversion_rules where organization_id='${GOV_ORG}';
  insert into public.meta_ads_conversion_rules(organization_id,stage_id,event_name,meta_event,configured_at) values ('${GOV_ORG}','${GOV_STAGE}','MetaEtapa:${GOV_STAGE}','LeadSubmitted','2020-01-01');
  update public.meta_ads_conversion_rules set configured_at='1999-01-01' where organization_id='${GOV_ORG}';
  select 'manteve=' || (configured_at='2020-01-01')::text from public.meta_ads_conversion_rules where organization_id='${GOV_ORG}';
  update public.meta_ads_conversion_rules set meta_event='InitiateCheckout' where organization_id='${GOV_ORG}';
  select 'reabriu=' || (configured_at > '2020-01-02')::text from public.meta_ads_conversion_rules where organization_id='${GOV_ORG}';
  ${migration}
  select 'sobreviveu=' || meta_event from public.meta_ads_conversion_rules where organization_id='${GOV_ORG}'; rollback;`);
    expect(output).toContain("manteve=true");
    expect(output).toContain("reabriu=true");
    expect(output).toContain("sobreviveu=InitiateCheckout");
  });
  it("reenvio de etapa da Meta exige o retrato do evento", () => {
    const output = sql(`begin;
  insert into public.ad_conversion_dispatches(organization_id,lead_id,platform,event_name,status,event_occurred_at) values ('${GOV_ORG}','${GOV_LEAD}','meta_ads','MetaEtapa:${GOV_STAGE}','error',now());
  select 'sem_retrato=' || public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}','MetaEtapa:${GOV_STAGE}')::text;
  update public.ad_conversion_dispatches set meta_event_name='LeadSubmitted' where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}' and event_name='MetaEtapa:${GOV_STAGE}';
  select 'com_retrato=' || public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}','MetaEtapa:${GOV_STAGE}')::text; rollback;`);
    expect(output).toContain("sem_retrato=false");
    expect(output).toContain("com_retrato=true");
  });
});
