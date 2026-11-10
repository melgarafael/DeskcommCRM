import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_SESSION,
  GOV_STAGE,
  seedGov,
  sql,
} from "./gov-helpers";

beforeAll(seedGov);

const CONTACT = "1ead5000-0000-4000-8000-000000000001";
const CONVERSATION = "1ead5000-0000-4000-8000-000000000002";
const MESSAGE = "1ead5000-0000-4000-8000-000000000003";
const CLICK = "ctwa-mensagem-causal";
const ANCHOR = JSON.stringify({
  meta_ctwa_message_v1: { platform: "meta_ads", source_type: "ad", ctwa_clid: CLICK },
});

function fixture(metadata = ANCHOR): string {
  return `
    insert into public.contacts(id,organization_id,display_name) values ('${CONTACT}','${GOV_ORG}','Lead causal');
    insert into public.conversations(id,organization_id,contact_id,channel_session_id,status,channel)
      values ('${CONVERSATION}','${GOV_ORG}','${CONTACT}','${GOV_SESSION}','open','whatsapp');
    insert into public.messages(id,organization_id,contact_id,conversation_id,channel_session_id,
      external_id,type,direction,status,metadata)
      values ('${MESSAGE}','${GOV_ORG}','${CONTACT}','${CONVERSATION}','${GOV_SESSION}',
      'causal-test-1','text','inbound','received','${metadata}'::jsonb);
  `;
}

function nascer(
  message = MESSAGE,
  contact = CONTACT,
  conversation = CONVERSATION,
  source = "whatsapp",
) {
  return `public.fn_nascer_lead_da_mensagem('${GOV_ORG}','${contact}','${GOV_PIPELINE}',
    '${GOV_STAGE}','Lead causal','${source}','{}'::jsonb,'{}'::text[],
    '${message}','${conversation}')`;
}

describe("LeadSubmitted: prova causal no banco", () => {
  it("nasce da mensagem com clique, preserva o payload canônico e emite exatamente um evento", () => {
    const out = sql(`begin; ${fixture()}
      select 'nasceu=' || (${nascer()})::text;
      select 'prova=' || (source_metadata->'meta_capi_lead_birth_v1'->>'ctwa_clid')
        from public.crm_leads where contact_id='${CONTACT}';
      select 'evento=' || count(*) || ':' || bool_and(event_type='lead.created'
        and entity_kind='crm_lead' and entity_id=(select id from public.crm_leads where contact_id='${CONTACT}')
        and organization_id='${GOV_ORG}'
        and payload=(jsonb_build_object('conversation_id','${CONVERSATION}',
          'pipeline_id','${GOV_PIPELINE}','stage_id','${GOV_STAGE}')
          || jsonb_build_object('service_origin',jsonb_build_object('kind','command',
            'observed',public.fn_service_observe_command('${GOV_ORG}','${CONTACT}'))))
        and metadata->>'source'='nascimento-da-conversa')
        from public.event_log where event_type='lead.created'
          and entity_id=(select id from public.crm_leads where contact_id='${CONTACT}');
      select 'segundo=' || coalesce((${nascer()})::text,'null'); rollback;`);
    expect(out).toContain(`prova=${CLICK}`);
    expect(out).toContain("evento=1:true");
    expect(out).toContain("segundo=null");
  });

  it.each([
    ["só anúncio", JSON.stringify({ ad_id: "anuncio-123", source_id: "anuncio-123" })],
    [
      "post orgânico",
      JSON.stringify({
        meta_ctwa_message_v1: { platform: "meta_ads", source_type: "post", ctwa_clid: CLICK },
      }),
    ],
    ["UTM de página", JSON.stringify({ utm_source: "instagram", ad_platform: "site" })],
  ])("%s não prova nascimento CTWA", (_name, metadata) => {
    const out = sql(`begin; ${fixture(metadata)}
      update public.contacts set source='meta_ads', source_metadata='{"ad_platform":"meta_ads","ad_source_id":"clique-antigo"}'::jsonb
        where id='${CONTACT}';
      select ${nascer()};
      select 'prova=' || (source_metadata ? 'meta_capi_lead_birth_v1')::text
        from public.crm_leads where contact_id='${CONTACT}'; rollback;`);
    expect(out).toContain("prova=false");
  });

  it("não herda chave reservada que entrou no first-touch do contato", () => {
    const out = sql(`begin; ${fixture("{}")}
      update public.contacts set source='meta_ads',
        source_metadata='{"meta_capi_lead_birth_v1":{"ctwa_clid":"forjado"},"ad_platform":"meta_ads"}'::jsonb
        where id='${CONTACT}';
      select ${nascer()};
      select 'prova=' || (source_metadata ? 'meta_capi_lead_birth_v1')::text
        from public.crm_leads where contact_id='${CONTACT}'; rollback;`);
    expect(out).toContain("prova=false");
  });

  it("recusa mensagem de outro contato ou conversa sem criar lead", () => {
    for (const args of [
      [GOV_CONTACT_1, CONVERSATION],
      [CONTACT, GOV_CONV_UNASSIGNED],
    ]) {
      expect(() =>
        sql(`begin; ${fixture()} select ${nascer(MESSAGE, args[0], args[1])}; rollback;`),
      ).toThrow();
    }
    expect(() =>
      sql(`begin; ${fixture()}
      select public.fn_nascer_lead_da_mensagem('00000000-0000-4000-8000-000000000099',
        '${CONTACT}','${GOV_PIPELINE}','${GOV_STAGE}','Lead','whatsapp','{}','{}',
        '${MESSAGE}','${CONVERSATION}'); rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()}
      select ${nascer("00000000-0000-4000-8000-000000000098")}; rollback;`),
    ).toThrow();
  });

  it("recusa mensagem outbound mesmo quando há contato e conversa válidos", () => {
    expect(
      sql(`begin; ${fixture("{}")}
        update public.messages set direction='outbound' where id='${MESSAGE}';
        select direction from public.messages where id='${MESSAGE}'; rollback;`),
    ).toContain("outbound");
    expect(() =>
      sql(`begin; ${fixture("{}")}
        update public.messages set direction='outbound' where id='${MESSAGE}';
        select ${nascer()}; rollback;`),
    ).toThrow();
  });

  it("authenticated não cria nem muda a chave da mensagem; metadados comuns continuam graváveis", () => {
    const claims = `select set_config('request.jwt.claims','{"sub":"${GOV_AGENT_A}"}',true);`;
    expect(() =>
      sql(`begin; ${fixture("{}")} set local role authenticated; ${claims}
      update public.messages set metadata='${ANCHOR}'::jsonb where id='${MESSAGE}'; rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture("{}")} set local role authenticated; ${claims}
      insert into public.messages(organization_id,contact_id,conversation_id,channel_session_id,
        external_id,type,direction,status,metadata)
      values ('${GOV_ORG}','${CONTACT}','${CONVERSATION}','${GOV_SESSION}',
        'causal-forged','text','inbound','received','${ANCHOR}'::jsonb); rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} set local role authenticated; ${claims}
      update public.messages set conversation_id='${GOV_CONV_UNASSIGNED}' where id='${MESSAGE}'; rollback;`),
    ).toThrow();
    const out = sql(`begin; ${fixture("{}")} set local role authenticated; ${claims}
      update public.messages set metadata='{"crm_hidden_at":"2026-01-01"}'::jsonb where id='${MESSAGE}';
      select metadata->>'crm_hidden_at' from public.messages where id='${MESSAGE}'; rollback;`);
    expect(out).toContain("2026-01-01");
    expect(
      sql(`begin; ${fixture()} select metadata->'meta_ctwa_message_v1'->>'ctwa_clid'
      from public.messages where id='${MESSAGE}'; rollback;`),
    ).toContain(CLICK);
    const service = sql(`begin; ${fixture("{}")} set local role service_role;
      update public.messages set metadata='${ANCHOR}'::jsonb where id='${MESSAGE}';
      select metadata->'meta_ctwa_message_v1'->>'ctwa_clid'
        from public.messages where id='${MESSAGE}'; rollback;`);
    expect(service).toContain(CLICK);
  });

  it("um rollback desfaz lead e lead.created conjuntamente", () => {
    const out = sql(`begin; ${fixture()} select ${nascer()}; rollback;
      select 'lead=' || count(*) from public.crm_leads where contact_id='${CONTACT}';
      select 'evento=' || count(*) from public.event_log where event_type='lead.created'
        and organization_id='${GOV_ORG}' and payload->>'conversation_id'='${CONVERSATION}';`);
    expect(out).toContain("lead=0");
    expect(out).toContain("evento=0");
  });

  it("campanha outbound não herda prova nem converte clique antigo", () => {
    const out = sql(`begin; ${fixture()}
      select ${nascer(MESSAGE, CONTACT, CONVERSATION, "campanha")};
      select 'prova=' || (source_metadata ? 'meta_capi_lead_birth_v1')::text
        from public.crm_leads where contact_id='${CONTACT}'; rollback;`);
    expect(out).toContain("prova=false");
  });

  it("outros canais continuam criando negócio, mas sem prova CTWA", () => {
    const out = sql(`begin; ${fixture()}
      update public.conversations set channel='instagram' where id='${CONVERSATION}';
      select 'nasceu=' || (${nascer()})::text;
      select 'prova=' || (source_metadata ? 'meta_capi_lead_birth_v1')::text
        from public.crm_leads where contact_id='${CONTACT}'; rollback;`);
    expect(out).toContain("nasceu=");
    expect(out).toContain("prova=false");
  });

  it("authenticated não insere nem altera a prova reservada do lead", () => {
    const claims = `select set_config('request.jwt.claims','{"sub":"${GOV_AGENT_A}"}',true);`;
    expect(() =>
      sql(`begin; set local role authenticated; ${claims}
      insert into public.crm_leads(organization_id,pipeline_id,stage_id,title,source_metadata)
      values ('${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','forjado',
        '{"meta_capi_lead_birth_v1":{"ctwa_clid":"falso"}}'::jsonb); rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()};
      set local role authenticated; ${claims}
      update public.crm_leads set source_metadata='{"meta_capi_lead_birth_v1":{"ctwa_clid":"falso"}}'::jsonb
        where contact_id='${CONTACT}'; rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()};
      set local role authenticated; ${claims}
      update public.crm_leads set created_at=now()-interval '30 days'
        where contact_id='${CONTACT}'; rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} set local role authenticated; ${claims}
      select ${nascer()}; rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()}; set local role authenticated; ${claims}
      select public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')); rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()}; set local role authenticated; ${claims}
      select public.fn_settle_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}'),
        '00000000-0000-4000-8000-000000000001','sent',null,null); rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()};
      update public.crm_leads set source_metadata = source_metadata ||
        '{"meta_capi_lead_birth_v1":{"ctwa_clid":"forjado"}}'::jsonb
        where contact_id='${CONTACT}'; rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()}; set local role service_role;
      update public.crm_leads set source_metadata = source_metadata ||
        '{"meta_capi_lead_birth_v1":{"ctwa_clid":"forjado"}}'::jsonb
        where contact_id='${CONTACT}'; rollback;`),
    ).toThrow();
    expect(() =>
      sql(`begin; ${fixture()} select ${nascer()};
      set local role authenticated; ${claims}
      select set_config('deskcomm.meta_capi_birth_lead_id',
        (select id::text from public.crm_leads where contact_id='${CONTACT}'),true);
      update public.crm_leads set source_metadata = source_metadata ||
        '{"meta_capi_lead_birth_v1":{"ctwa_clid":"forjado"}}'::jsonb
        where contact_id='${CONTACT}'; rollback;`),
    ).toThrow();
  });

  it("claim tem dono único, lease retomável, sent terminal e eventos independentes", () => {
    const out = sql(`begin; ${fixture()} select ${nascer()};
      create temporary table claims as select public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')) as first_claim;
      select 'primeiro=' || (first_claim->>'acquired') from claims;
      select 'outra_org=' || ((public.fn_claim_meta_lead_submitted(
        '00000000-0000-4000-8000-000000000099',
        (select id from public.crm_leads where contact_id='${CONTACT}')))->>'acquired');
      select 'busy=' || ((public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')))->>'acquired');
      update public.ad_conversion_dispatches set claimed_until=now()-interval '1 second'
        where organization_id='${GOV_ORG}' and event_name='LeadSubmitted';
      create temporary table claims2 as select public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')) as second_claim;
      select 'retomou=' || (second_claim->>'acquired') from claims2;
      select 'mesmo_event_id=' || (d.event_id=(l.id::text||':LeadSubmitted'))::text
        from public.ad_conversion_dispatches d join public.crm_leads l on l.id=d.lead_id
        where l.contact_id='${CONTACT}';
      select 'velho=' || public.fn_settle_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}'),
        (select (first_claim->>'token')::uuid from claims),'sent',null,null)::text;
      select 'novo=' || public.fn_settle_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}'),
        (select (second_claim->>'token')::uuid from claims2),'sent',null,null)::text;
      select 'terminal=' || ((public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')))->>'acquired');
      insert into public.ad_conversion_dispatches(organization_id,lead_id,platform,event_name,status)
        select '${GOV_ORG}',id,'meta_ads','Purchase','sent' from public.crm_leads where contact_id='${CONTACT}';
      insert into public.ad_conversion_dispatches(organization_id,lead_id,platform,event_name,status)
        select '${GOV_ORG}',id,'meta_ads','MetaEtapa:${GOV_STAGE}','sent' from public.crm_leads where contact_id='${CONTACT}';
      insert into public.ad_conversion_dispatches(organization_id,lead_id,platform,event_name,status)
        select '${GOV_ORG}',id,'google_ads','QualifiedLead','sent' from public.crm_leads where contact_id='${CONTACT}';
      select 'coexistem=' || count(*) from public.ad_conversion_dispatches
        where organization_id='${GOV_ORG}' and lead_id=(select id from public.crm_leads where contact_id='${CONTACT}');
      rollback;`);
    expect(out).toContain("primeiro=true");
    expect(out).toContain("outra_org=false");
    expect(out).toContain("busy=false");
    expect(out).toContain("retomou=true");
    expect(out).toContain("mesmo_event_id=true");
    expect(out).toContain("velho=false");
    expect(out).toContain("novo=true");
    expect(out).toContain("terminal=false");
    expect(out).toContain("coexistem=4");
  });

  it("claim não assume uma linha LeadSubmitted com plataforma ou event_id incompatíveis", () => {
    const out = sql(`begin; ${fixture()} select ${nascer()};
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,event_id)
      select '${GOV_ORG}',id,'google_ads','LeadSubmitted','skipped','outro-evento'
        from public.crm_leads where contact_id='${CONTACT}';
      select 'claim=' || ((public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')))->>'status');
      select 'linha=' || platform || ':' || event_id
        from public.ad_conversion_dispatches where organization_id='${GOV_ORG}'
          and event_name='LeadSubmitted'; rollback;`);
    expect(out).toContain("claim=invalid_ledger");
    expect(out).toContain("linha=google_ads:outro-evento");
  });

  it("claim não assume uma linha com retrato de evento ou horário divergente", () => {
    const out = sql(`begin; ${fixture()} select ${nascer()};
      insert into public.ad_conversion_dispatches
        (organization_id,lead_id,platform,event_name,status,event_id,meta_event_name,event_occurred_at)
      select '${GOV_ORG}',id,'meta_ads','LeadSubmitted','skipped',
        id::text||':LeadSubmitted','Purchase',created_at
        from public.crm_leads where contact_id='${CONTACT}';
      select 'claim=' || ((public.fn_claim_meta_lead_submitted('${GOV_ORG}',
        (select id from public.crm_leads where contact_id='${CONTACT}')))->>'status');
      rollback;`);
    expect(out).toContain("claim=invalid_ledger");
  });
});
