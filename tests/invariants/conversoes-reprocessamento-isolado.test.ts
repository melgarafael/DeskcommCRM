import { beforeAll, describe, expect, it } from "vitest";
import { GOV_ORG, GOV_LEAD, seedGov, sql } from "./gov-helpers";

beforeAll(seedGov);
const iniciar = `begin;
 update public.crm_leads set status='won', closed_at=now() where id='${GOV_LEAD}';
 insert into public.ad_conversion_dispatches (organization_id, lead_id, platform, event_name, status, reason)
 values ('${GOV_ORG}', '${GOV_LEAD}', 'google_ads', 'Purchase', 'error', 'recusado_pela_plataforma')
 on conflict (organization_id,lead_id,event_name) do update set status='error';`;

describe("conversões: porta de reprocessamento", () => {
  it("anon e authenticated não executam a RPC nem leem os protocolos", () => {
    expect(
      sql(`select has_function_privilege('anon','public.fn_solicitar_reenvio_conversao(uuid,uuid)','execute'),
      has_function_privilege('authenticated','public.fn_solicitar_reenvio_conversao(uuid,uuid)','execute'),
      has_table_privilege('authenticated','public.ad_conversion_dispatches','select');`),
    ).toBe("f|f|f");
  });
  it("outra organização não agenda, repetição agenda um único evento exclusivo", () => {
    const out = sql(`${iniciar}
      select public.fn_solicitar_reenvio_conversao('00000000-0000-4000-8000-000000000000','${GOV_LEAD}');
      select public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}');
      select public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}');
      select count(*) from public.event_log where organization_id='${GOV_ORG}' and entity_id='${GOV_LEAD}' and event_type='ad_conversion.retry_requested';
      rollback;`);
    expect(out).toContain("f\nt\nf\n1");
  });
  it("envio concluído não é rebaixado por uma tentativa atrasada", () => {
    const out = sql(`${iniciar}
      update public.ad_conversion_dispatches set status='sent' where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      update public.ad_conversion_dispatches set status='error' where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      select status from public.ad_conversion_dispatches where organization_id='${GOV_ORG}' and lead_id='${GOV_LEAD}';
      select public.fn_solicitar_reenvio_conversao('${GOV_ORG}','${GOV_LEAD}');
      rollback;`);
    expect(out).toContain("sent\nf");
  });
});
