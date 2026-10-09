/** O vínculo de canal é limitado pelo banco, mesmo com service_role. Avisos têm
 * ciclo completo: dedup, resolução após cancelamento/vencimento/desativação. */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("Use pnpm test:db");
function sql(script: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}
const A = "ca110009-0000-4000-8000-000000000001";
const B = "ca110009-0000-4000-8000-000000000002";
const C = "ca110009-0000-4000-8000-000000000003";
const D = "ca110009-0000-4000-8000-000000000004";
const T = "ca110009-0000-4000-8000-000000000005";
const USER = "ca110009-0000-4000-8000-000000000006";
beforeAll(() => {
  sql(`insert into organizations(id,slug,legal_name,display_name) values
    ('${A}','lembrete-remetente-a','A','A'),('${B}','lembrete-remetente-b','B','B');
    insert into channel_sessions(id,organization_id,webhook_secret_encrypted,waha_session_name) values ('${C}','${A}','fixture','fixture-a'),('${D}','${B}','fixture','fixture-b');
    insert into calendar_event_types(id,organization_id,name,slug,reminder_enabled) values ('${T}','${A}','Teste remetente','teste-remetente',true);
    insert into auth.users(id,email) values('${USER}','remetente-manager@invariant.test');
    insert into user_organizations(user_id,organization_id,role) values('${USER}','${A}','manager');`);
});
describe("configuração de remetente em banco real", () => {
  it("legado nasce nulo, canal da mesma organização persiste e nulo permite voltar", () => {
    expect(
      sql(`select reminder_channel_session_id is null from calendar_event_types where id='${T}'`),
    ).toBe("t");
    sql(`update calendar_event_types set reminder_channel_session_id='${C}' where id='${T}';`);
    expect(
      sql(`select reminder_channel_session_id from calendar_event_types where id='${T}'`),
    ).toBe(C);
    sql(`update calendar_event_types set reminder_channel_session_id=null where id='${T}';`);
  });
  it("service_role também não consegue associar canal de outra organização", () => {
    expect(() =>
      sql(
        `begin; set role service_role; update calendar_event_types set reminder_channel_session_id='${D}' where id='${T}'; commit;`,
      ),
    ).toThrow(/calendar_event_types_reminder_channel_org_fkey/);
    expect(
      sql(`select reminder_channel_session_id is null from calendar_event_types where id='${T}'`),
    ).toBe("t");
  });
  it("manager grava sua configuração pela RLS; outra organização permanece invisível", () => {
    const out =
      sql(`begin; set role authenticated; select set_config('request.jwt.claims','{"sub":"${USER}"}',true);
      update calendar_event_types set reminder_channel_session_id='${C}' where id='${T}' returning reminder_channel_session_id;
      select count(*) from calendar_event_types where organization_id='${B}'; commit;`);
    expect(out).toContain(C);
    expect(out).toContain("\n0\n");
  });
  it("aviso duplicado é recusado atomicamente, mas pode reabrir após resolução", () => {
    sql(
      `insert into agent_inbox_items(organization_id,kind,title,ref_kind,ref_id) values('${A}','other','Canal pendente','agenda_reminder_sender','${T}');`,
    );
    expect(() =>
      sql(
        `insert into agent_inbox_items(organization_id,kind,title,ref_kind,ref_id) values('${A}','other','Canal pendente','agenda_reminder_sender','${T}');`,
      ),
    ).toThrow(/agent_inbox_reminder_sender_open_unique/);
    sql(`update agent_inbox_items set status='resolved' where ref_id='${T}';
      insert into agent_inbox_items(organization_id,kind,title,ref_kind,ref_id) values('${A}','other','Canal pendente','agenda_reminder_sender','${T}');`);
    expect(
      sql(`select count(*) from agent_inbox_items where ref_id='${T}' and status='open'`),
    ).toBe("1");
  });
  it("limpeza fecha cancelados, vencidos, apagados e tipo desligado; preserva o válido", () => {
    sql(`insert into calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,status)
      values ('${A}','${T}','válido',now()+interval '2 days',now()+interval '2 days 1 hour','confirmed'),
      ('${A}','${T}','cancelado',now()+interval '2 days',now()+interval '2 days 1 hour','confirmed'),
      ('${A}','${T}','vencido',now()-interval '2 days',now()-interval '2 days'+interval '1 hour','confirmed');
      update calendar_appointments set status='cancelled',cancelled_at=now(),cancellation_reason='teste' where organization_id='${A}' and title='cancelado';
      insert into agent_inbox_items(organization_id,kind,title,ref_kind,ref_id)
        select organization_id,'other',title,'agenda_reminder_sender',id from calendar_appointments where organization_id='${A}';
      select fn_resolver_avisos_de_lembrete_expirados();`);
    expect(
      sql(
        `select string_agg(title,',') from agent_inbox_items where ref_kind='agenda_reminder_sender' and status='open'`,
      ),
    ).toBe("válido");
    sql(
      `update calendar_event_types set reminder_enabled=false where id='${T}'; select fn_resolver_avisos_de_lembrete_expirados();`,
    );
    expect(
      sql(
        `select count(*) from agent_inbox_items where ref_kind='agenda_reminder_sender' and status='open'`,
      ),
    ).toBe("0");
  });
  it("limpeza global não fica exposta a membros ou anônimos", () => {
    expect(
      sql(
        `select has_function_privilege('anon','public.fn_resolver_avisos_de_lembrete_expirados()','execute'),has_function_privilege('authenticated','public.fn_resolver_avisos_de_lembrete_expirados()','execute'),has_function_privilege('service_role','public.fn_resolver_avisos_de_lembrete_expirados()','execute')`,
      ),
    ).toBe("f|f|t");
  });
});

describe("integrações do vínculo novo", () => {
  it("anonimização fecha o aviso e remove o ponteiro de identidade", () => {
    sql(`do $$ declare c uuid; a uuid; begin
      insert into contacts(organization_id,name,phone_number) values('${A}','Pessoa fictícia','+5500000000000') returning id into c;
      insert into calendar_appointments(organization_id,event_type_id,contact_id,title,starts_at,ends_at)
        values('${A}','${T}',c,'Sem título pessoal',now()+interval '3 days',now()+interval '3 days 1 hour') returning id into a;
      insert into agent_inbox_items(organization_id,kind,title,ref_kind,ref_id)
        values('${A}','other','Prova anonimização','agenda_reminder_sender',a);
      perform public.fn_lgpd_cascade_redact_contact('${A}',c,null);
    end $$;`);
    expect(
      sql(
        `select status,ref_id is null,body from agent_inbox_items where title='Prova anonimização'`,
      ),
    ).toBe("resolved|t|Contato anonimizado.");
  });
  it("exclusão da organização não é bloqueada pela referência entre suas próprias tabelas", () => {
    expect(() =>
      sql(`do $$ declare o uuid; c uuid; begin
      insert into organizations(slug,legal_name,display_name) values('lembrete-remetente-apagavel','Apagável','Apagável') returning id into o;
      insert into channel_sessions(organization_id,waha_session_name,webhook_secret_encrypted) values(o,'fixture-apagavel','fixture') returning id into c;
      update calendar_event_types set reminder_channel_session_id=c where organization_id=o;
      delete from organizations where id=o;
    end $$;`),
    ).not.toThrow();
  });
});
