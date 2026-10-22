import { beforeAll, describe, expect, it } from "vitest";
import {
  GOV_CONTACT_1,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_SESSION,
  GOV_STAGE,
  seedGov,
  sql,
} from "./gov-helpers";

beforeAll(seedGov);

const CONTACT = "c11c0000-0000-4000-8000-000000000001";
const CONVERSATION = "c11c0000-0000-4000-8000-000000000002";
const OTHER_ORG = "c11c0000-0000-4000-8000-000000000003";
const OTHER_CONTACT = "c11c0000-0000-4000-8000-000000000004";
const OTHER_CONVERSATION = "c11c0000-0000-4000-8000-000000000005";
const MESSAGE = (n: number) => `c11c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const anchor = (clid: string) =>
  JSON.stringify({
    meta_ctwa_message_v1: { platform: "meta_ads", source_type: "ad", ctwa_clid: clid },
  });
const setup = `
  insert into public.contacts(id,organization_id,display_name)
    values ('${CONTACT}','${GOV_ORG}','Contato sintetico');
  insert into public.conversations(id,organization_id,contact_id,channel_session_id,status,channel)
    values ('${CONVERSATION}','${GOV_ORG}','${CONTACT}','${GOV_SESSION}','open','whatsapp');`;
function message(n: number, metadata = anchor(`click-${n}`)) {
  return `insert into public.messages(id,organization_id,contact_id,conversation_id,
    channel_session_id,external_id,type,direction,status,metadata)
    values ('${MESSAGE(n)}','${GOV_ORG}','${CONTACT}','${CONVERSATION}',
      '${GOV_SESSION}','external-${n}','text','inbound','received','${metadata}'::jsonb);`;
}
const birth = (n: number) => `public.fn_nascer_lead_da_mensagem(
  '${GOV_ORG}','${CONTACT}','${GOV_PIPELINE}','${GOV_STAGE}',
  'Lead sintetico','whatsapp','{}'::jsonb,'{}'::text[],
  '${MESSAGE(n)}','${CONVERSATION}')`;

describe("LeadSubmitted por clique: banco", () => {
  it("tres cliques do mesmo contato conservam um card e tres identidades", () => {
    const out = sql(`begin; ${setup}
      update public.contacts set source_metadata='{"ad_source_id":"primeiro-toque"}'::jsonb
        where id='${CONTACT}';
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      ${message(1)}
      select 'primeiro=' || (${birth(1)})::text;
      ${message(2)}
      select 'segundo=' || coalesce((${birth(2)})::text,'null');
      ${message(3)}
      select 'terceiro=' || coalesce((${birth(3)})::text,'null');
      select 'estado=' || count(*) || ':' || count(distinct ctwa_clid) || ':' ||
        count(distinct event_id) || ':' || bool_and(status='pending' and activation_at_capture is not null)
        from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}';
      select 'cards=' || count(*) from public.crm_leads
        where organization_id='${GOV_ORG}' and contact_id='${CONTACT}';
      select 'primeiro_toque=' || coalesce(source_metadata->>'ad_source_id','null')
        from public.contacts where id='${CONTACT}'; rollback;`);
    expect(out).toContain("segundo=null");
    expect(out).toContain("terceiro=null");
    expect(out).toContain("estado=3:3:3:true");
    expect(out).toContain("cards=1");
    expect(out).toContain("primeiro_toque=primeiro-toque");
  });

  it("repetir o mesmo clid preserva primeira mensagem e um so claim", () => {
    const out = sql(`begin; ${setup}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      ${message(1, anchor("clique-repetido"))}
      ${message(2, anchor("clique-repetido"))}
      insert into public.contacts(id,organization_id,display_name)
        values ('${OTHER_CONTACT}','${GOV_ORG}','Outro contato do mesmo tenant');
      insert into public.conversations(id,organization_id,contact_id,channel_session_id,status,channel)
        values ('${OTHER_CONVERSATION}','${GOV_ORG}','${OTHER_CONTACT}',
          '${GOV_SESSION}','open','whatsapp');
      insert into public.messages(id,organization_id,contact_id,conversation_id,
        channel_session_id,external_id,type,direction,status,metadata)
        values ('${MESSAGE(3)}','${GOV_ORG}','${OTHER_CONTACT}','${OTHER_CONVERSATION}',
          '${GOV_SESSION}','outro-contato','text','inbound','received',
          '${anchor("clique-repetido")}'::jsonb);
      select 'identidade=' || count(*) || ':' || min(first_message_id::text) ||
        ':' || min(contact_id::text)
        from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}';
      with c as (select id from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}')
      select 'claim1=' || (public.fn_claim_meta_ctwa_click('${GOV_ORG}',id)->>'status') from c;
      with c as (select id from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}')
      select 'claim2=' || (public.fn_claim_meta_ctwa_click('${GOV_ORG}',id)->>'status') from c;
      select 'legacy=' || count(*) from public.ad_conversion_dispatches
        where organization_id='${GOV_ORG}'; rollback;`);
    expect(out).toContain(`identidade=1:${MESSAGE(1)}:${CONTACT}`);
    expect(out).toContain("claim1=processing");
    expect(out).toContain("claim2=busy");
    expect(out).toContain("legacy=0");
  });

  it("clique enviado pelo ledger legado nao gera segundo evento apos a migration", () => {
    const out = sql(`begin; ${setup}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      ${message(1, anchor("clique-historico-enviado"))}
      select 'nascimento=' || (${birth(1)})::text;
      select 'prova=' || (source_metadata->'meta_capi_lead_birth_v1'->>'ctwa_clid')
        from public.crm_leads where organization_id='${GOV_ORG}' and contact_id='${CONTACT}';
      -- Simula a instalacao anterior: a mensagem e a prova existem, mas o
      -- livro por clique ainda nao existia quando o ledger legado foi enviado.
      delete from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}' and ctwa_clid='clique-historico-enviado';
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,event_id,
         event_occurred_at,meta_event_name)
        select organization_id,id,'meta_ads','LeadSubmitted','sent',
          id::text||':LeadSubmitted',created_at,'LeadSubmitted'
        from public.crm_leads
        where organization_id='${GOV_ORG}' and contact_id='${CONTACT}';
      ${message(2, anchor("clique-historico-enviado"))}
      select 'historia=' || status || ':' || reason
        from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}' and ctwa_clid='clique-historico-enviado';
      select 'claim=' || (public.fn_claim_meta_ctwa_click(
        '${GOV_ORG}',id)->>'status')
        from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}' and ctwa_clid='clique-historico-enviado';
      select 'retry=' || public.fn_solicitar_reenvio_meta_ctwa_click(
        '${GOV_ORG}',(select id from public.meta_ctwa_click_dispatches
          where organization_id='${GOV_ORG}' and ctwa_clid='clique-historico-enviado'))::text;
      ${message(3, anchor("clique-genuinamente-novo"))}
      select 'novo=' || status || ':' || (public.fn_claim_meta_ctwa_click(
        '${GOV_ORG}',id)->>'status')
        from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}' and ctwa_clid='clique-genuinamente-novo';
      select 'ledger=' || count(*) || ':' || count(distinct event_id)
        from public.ad_conversion_dispatches
        where organization_id='${GOV_ORG}' and event_name='LeadSubmitted';
      rollback;`);
    expect(out).toContain("prova=clique-historico-enviado");
    expect(out).toContain("historia=skipped:lead_submitted_legado_enviado");
    expect(out).toContain("claim=legacy_sent");
    expect(out).toContain("retry=false");
    expect(out).toContain("novo=pending:processing");
    expect(out).toContain("ledger=1:1");
  });

  it("desligado no clique e reativacao nao criam elegibilidade retroativa", () => {
    const out = sql(`begin; ${setup}
      ${message(1)}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      ${message(2)}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',false);
      ${message(3)}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      select 'estados=' || string_agg(ctwa_clid || ':' || status,',' order by first_message_id)
        from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}';
      select 'epoch_antigo=' || count(*) from public.meta_ctwa_click_dispatches c
        join public.organizations o on o.id=c.organization_id
        where c.organization_id='${GOV_ORG}' and c.status='pending'
          and c.activation_at_capture=o.meta_lead_birth_enabled_at;
      rollback;`);
    expect(out).toContain("estados=click-1:skipped,click-2:pending,click-3:skipped");
    expect(out).toContain("epoch_antigo=0");
  });

  it("evidencia organica ou forjada pelo authenticated nao cria clique", () => {
    const out = sql(`begin; ${setup}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      ${message(1, "{}")}
      ${message(2, JSON.stringify({ ad_id: "anuncio-sem-clid" }))}
      select 'cliques=' || count(*) from public.meta_ctwa_click_dispatches
        where organization_id='${GOV_ORG}'; rollback;`);
    expect(out).toContain("cliques=0");
    expect(() =>
      sql(`begin; ${setup}
      set local role authenticated;
      ${message(1)} rollback;`),
    ).toThrow();
  });

  it("escopo incoerente reverte a mensagem em vez de perder o clique", () => {
    expect(() =>
      sql(`begin;
        insert into public.contacts(id,organization_id,display_name)
          values ('${CONTACT}','${GOV_ORG}','Contato sintetico');
        insert into public.conversations(id,organization_id,contact_id,channel_session_id,status,channel)
          values ('${CONVERSATION}','${GOV_ORG}','${CONTACT}',
            '${GOV_SESSION}','open','instagram');
        insert into public.messages(id,organization_id,contact_id,conversation_id,
          channel_session_id,external_id,type,direction,status,metadata)
          values ('${MESSAGE(1)}','${GOV_ORG}','${CONTACT}','${CONVERSATION}',
            '${GOV_SESSION}','escopo-incoerente','text','inbound','received',
            '${anchor("clique-escopo-incoerente")}'::jsonb);
        commit;`),
    ).toThrow("meta_ctwa_click_scope_mismatch");
    expect(
      sql(`select count(*) from public.messages
        where organization_id='${GOV_ORG}' and external_id='escopo-incoerente';`),
    ).toBe("0");
  });

  it("RLS, grants e identidade imutavel preservam o isolamento", () => {
    const out = sql(`select 'acl=' ||
      has_table_privilege('anon','public.meta_ctwa_click_dispatches','select')::text || ':' ||
      has_table_privilege('authenticated','public.meta_ctwa_click_dispatches','select')::text || ':' ||
      has_table_privilege('service_role','public.meta_ctwa_click_dispatches','select')::text;
      select 'rls=' || relrowsecurity::text from pg_class
        where oid='public.meta_ctwa_click_dispatches'::regclass;
      select 'policies=' || count(*) from pg_policies
        where schemaname='public' and tablename='meta_ctwa_click_dispatches';
      select 'rpc=' || has_function_privilege('anon','public.fn_claim_meta_ctwa_click(uuid,uuid)','execute')::text
        || ':' || has_function_privilege('service_role','public.fn_claim_meta_ctwa_click(uuid,uuid)','execute')::text;
      select 'legacy_helper=' ||
        has_function_privilege('anon','public.fn_meta_ctwa_click_enviado_legado(uuid,text)','execute')::text || ':' ||
        has_function_privilege('authenticated','public.fn_meta_ctwa_click_enviado_legado(uuid,text)','execute')::text || ':' ||
        has_function_privilege('service_role','public.fn_meta_ctwa_click_enviado_legado(uuid,text)','execute')::text;`);
    expect(out).toContain("acl=false:false:true");
    expect(out).toContain("rls=true");
    expect(out).toContain("policies=0");
    expect(out).toContain("rpc=false:true");
    expect(out).toContain("legacy_helper=false:false:true");
    expect(() =>
      sql(`begin; ${setup}
      ${message(1)}
      update public.meta_ctwa_click_dispatches set contact_id='${GOV_CONTACT_1}'
        where organization_id='${GOV_ORG}'; rollback;`),
    ).toThrow();
  });

  it("retry autorizado emite evento do mesmo clique, sem tocar conversoes antigas", () => {
    const out = sql(`begin; ${setup}
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      ${message(1)}
      update public.meta_ctwa_click_dispatches set status='error'
        where organization_id='${GOV_ORG}';
      select 'outro_tenant=' || public.fn_solicitar_reenvio_meta_ctwa_click(
        '99999999-9999-4999-8999-999999999999',
        (select id from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}'))::text;
      select 'agendou=' || public.fn_solicitar_reenvio_meta_ctwa_click(
        '${GOV_ORG}',(select id from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}'))::text;
      select 'evento=' || count(*) from public.event_log e
        join public.meta_ctwa_click_dispatches c on c.id=e.entity_id
        where e.organization_id='${GOV_ORG}' and e.event_type='ad_conversion.click_retry_requested';
      select 'ledger_antigo=' || count(*) from public.ad_conversion_dispatches
        where organization_id='${GOV_ORG}';
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',false);
      select 'desligado=' || public.fn_solicitar_reenvio_meta_ctwa_click(
        '${GOV_ORG}',(select id from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}'))::text;
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      select 'reativado=' || public.fn_solicitar_reenvio_meta_ctwa_click(
        '${GOV_ORG}',(select id from public.meta_ctwa_click_dispatches where organization_id='${GOV_ORG}'))::text;
      rollback;`);
    expect(out).toContain("outro_tenant=false");
    expect(out).toContain("agendou=true");
    expect(out).toContain("evento=1");
    expect(out).toContain("ledger_antigo=0");
    expect(out).toContain("desligado=false");
    expect(out).toContain("reativado=false");
  });

  it("a mesma identidade CTWA pertence separadamente a cada organizacao", () => {
    const out = sql(`begin; ${setup}
      insert into public.organizations(id,slug,legal_name,display_name)
        values ('${OTHER_ORG}','outro-tenant-clique','Outro tenant sintetico','Outro tenant');
      insert into public.contacts(id,organization_id,display_name)
        values ('${OTHER_CONTACT}','${OTHER_ORG}','Outro contato sintetico');
      insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
        values ('c11c0000-0000-4000-8000-000000000006','${OTHER_ORG}',
          'outro-canal-clique','\\x00'::bytea);
      insert into public.conversations(id,organization_id,contact_id,channel_session_id,status,channel)
        values ('${OTHER_CONVERSATION}','${OTHER_ORG}','${OTHER_CONTACT}',
          'c11c0000-0000-4000-8000-000000000006','open','whatsapp');
      select public.fn_definir_meta_lead_birth('${GOV_ORG}',true);
      select public.fn_definir_meta_lead_birth('${OTHER_ORG}',true);
      ${message(1, anchor("mesmo-clid-entre-tenants"))}
      insert into public.messages(id,organization_id,contact_id,conversation_id,
        channel_session_id,external_id,type,direction,status,metadata)
        values ('${MESSAGE(2)}','${OTHER_ORG}','${OTHER_CONTACT}','${OTHER_CONVERSATION}',
          'c11c0000-0000-4000-8000-000000000006','outro-external','text','inbound',
          'received','${anchor("mesmo-clid-entre-tenants")}'::jsonb);
      select 'identidades=' || count(*) || ':' || count(distinct organization_id)
        from public.meta_ctwa_click_dispatches where ctwa_clid='mesmo-clid-entre-tenants';
      rollback;`);
    expect(out).toContain("identidades=2:2");
  });
});
