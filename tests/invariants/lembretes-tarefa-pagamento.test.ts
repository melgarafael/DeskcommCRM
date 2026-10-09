import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "./psql-transporte";

const ORG = "05380000-0000-4000-8000-000000000001";
const ORG2 = "05380000-0000-4000-8000-000000000002";
const CHANNEL = "05380000-2222-4000-8000-000000000001";
const CONTACT = "05380000-3333-4000-8000-000000000001";
const CONVERSATION = "05380000-4444-4000-8000-000000000001";
const CASE = "05380000-5555-4000-8000-000000000001";
const USER = "05380000-1111-4000-8000-000000000001";
const USER2 = "05380000-1111-4000-8000-000000000002";
const CHANNEL2 = "05380000-2222-4000-8000-000000000002";
const CONTACT2 = "05380000-3333-4000-8000-000000000002";
const CONVERSATION2 = "05380000-4444-4000-8000-000000000002";
const CASE2 = "05380000-5555-4000-8000-000000000002";
const number = (query: string) => Number(sql(query).split("\n").at(-1));

beforeAll(() => {
  sql(`
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${ORG}','task-reminders-0538','Task reminders','Task reminders'),
      ('${ORG2}','task-reminders-other-0538','Other reminders','Other reminders') on conflict do nothing;
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
      values('${CHANNEL}','${ORG}','task-reminders-0538','\\x00'::bytea) on conflict do nothing;
    insert into public.config_aviso_de_caso(organization_id,channel_session_id,telefone_destino,ligado)
      values('${ORG}','${CHANNEL}','+15555550123',false)
      on conflict (organization_id) do update set channel_session_id=excluded.channel_session_id,
        telefone_destino=excluded.telefone_destino,ligado=false,repetir_lembretes_whatsapp=false;
    insert into public.contacts(id,organization_id,display_name) values('${CONTACT}','${ORG}','Test contact') on conflict do nothing;
    insert into public.conversations(id,organization_id,contact_id,channel_session_id,status)
      values('${CONVERSATION}','${ORG}','${CONTACT}','${CHANNEL}','open') on conflict do nothing;
    insert into public.agent_cases(id,organization_id,conversation_id,status,source,title,summary,blocker)
      values('${CASE}','${ORG}','${CONVERSATION}','awaiting_human','agent','Test task','summary','blocker') on conflict do nothing;
  `);
});

function reset(age: string) {
  sql(`delete from public.event_log where organization_id='${ORG}'
      and event_type='ai.case_task_reminder_due' and entity_id='${CASE}';
    delete from public.case_task_reminders where organization_id='${ORG}';
    delete from public.entregas_de_aviso_de_caso where organization_id='${ORG}' and case_id='${CASE}';
    delete from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}';
    update public.config_aviso_de_caso set repetir_lembretes_whatsapp=false where organization_id='${ORG}';
    update public.agent_cases set task_kind='payment_details',task_state='awaiting_human',
      wait_generation=wait_generation+1,wait_started_at=clock_timestamp()-interval '${age}',status='awaiting_human'
      where organization_id='${ORG}' and id='${CASE}';`);
}

describe("0602 — recibo e Central na mesma transação", () => {
  it("duas instâncias concorrentes gravam um recibo e um aviso", async () => {
    reset("3 minutes");
    const local = process.env.TEST_DB_PSQL;
    const args = local
      ? [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres"]
      : [
          "exec",
          process.env.TEST_DB_CONTAINER as string,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
        ];
    const rodada = () =>
      promisify(execFile)(local ?? "docker", [
        ...args,
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        "select public.fn_processar_lembretes_tarefa();",
      ]);
    await Promise.all([rodada(), rodada()]);
    expect(
      number(`select count(*) from public.case_task_reminders where organization_id='${ORG}'`),
    ).toBe(1);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
      ),
    ).toBe(1);
  });
  it("não cobra antes de3min; repetição não duplica; comentários não reiniciam espera", () => {
    reset("2 minutes");
    sql("select public.fn_processar_lembretes_tarefa();");
    expect(
      number(`select count(*) from public.case_task_reminders where organization_id='${ORG}'`),
    ).toBe(0);
    sql(`update public.agent_cases set wait_started_at=clock_timestamp()-interval '3 minutes' where id='${CASE}' and organization_id='${ORG}';
      select public.fn_processar_lembretes_tarefa();
      update public.agent_cases set updated_at=clock_timestamp() where id='${CASE}' and organization_id='${ORG}';
      select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(`select count(*) from public.case_task_reminders where organization_id='${ORG}'`),
    ).toBe(1);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
      ),
    ).toBe(1);
  });

  it("cobra caso geral, pausa enquanto aguarda o cliente e reabre em um novo episódio", () => {
    reset("10 minutes");
    sql(`update public.agent_cases
            set task_kind=null, task_state=null, status='awaiting_human',
                wait_generation=wait_generation+1,
                wait_started_at=clock_timestamp()-interval '10 minutes'
          where organization_id='${ORG}' and id='${CASE}';
      insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,status)
        values('${ORG}','case_stale','warn','Alerta antigo','aguardando resposta','agent_case','${CASE}','open');`);
    const alertaExistente = sql(
      `select id from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
    );

    sql("select public.fn_processar_lembretes_tarefa();");
    expect(
      number(
        `select count(*) from public.case_task_reminders where organization_id='${ORG}' and case_id='${CASE}' and result='notified' and minute=9`,
      ),
    ).toBe(1);
    expect(
      sql(
        `select id from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
      ),
    ).toBe(alertaExistente);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
      ),
    ).toBe(1);

    sql(`update public.agent_cases set status='awaiting_lead'
          where organization_id='${ORG}' and id='${CASE}';
      select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
      ),
    ).toBe(0);

    sql(`update public.agent_cases set status='awaiting_human',
                wait_generation=wait_generation+1,
                wait_started_at=clock_timestamp()-interval '3 minutes'
          where organization_id='${ORG}' and id='${CASE}';
      select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
      ),
    ).toBe(1);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
      ),
    ).toBe(2);
  });

  it("recupera atraso10min com um aviso9 e recibos inferiores ultrapassados", () => {
    reset("10 minutes");
    sql(`update public.config_aviso_de_caso set repetir_lembretes_whatsapp=true where organization_id='${ORG}';
      select public.fn_processar_lembretes_tarefa(); select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(
        `select count(*) from public.case_task_reminders where organization_id='${ORG}' and result='notified' and minute=9`,
      ),
    ).toBe(1);
    expect(
      number(
        `select count(*) from public.case_task_reminders where organization_id='${ORG}' and result='superseded'`,
      ),
    ).toBe(2);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
      ),
    ).toBe(1);
    expect(
      number(`select count(*) from public.event_log where organization_id='${ORG}'
        and event_type='ai.case_task_reminder_due' and entity_id='${CASE}'
        and payload->>'case_id'='${CASE}' and payload->>'wait_generation' is not null
        and payload->>'minute'='9' and (select count(*) from jsonb_object_keys(event_log.payload))=3`),
    ).toBe(1);
    expect(
      number(`select count(*) from public.event_log where organization_id='${ORG}'
        and event_type='ai.case_task_reminder_due' and entity_id='${CASE}'
        and payload->>'minute' in ('3','6')`),
    ).toBe(0);
  });

  it("mantém WhatsApp desligado por padrão e registra o evento no marco atual quando há opt-in", () => {
    reset("3 minutes");
    expect(
      number(
        `select repetir_lembretes_whatsapp::int from public.config_aviso_de_caso where organization_id='${ORG}'`,
      ),
    ).toBe(0);
    sql("select public.fn_processar_lembretes_tarefa();");
    expect(
      number(`select count(*) from public.event_log where organization_id='${ORG}'
        and event_type='ai.case_task_reminder_due' and entity_id='${CASE}'`),
    ).toBe(0);

    sql(`update public.config_aviso_de_caso set repetir_lembretes_whatsapp=true where organization_id='${ORG}';
      select public.fn_processar_lembretes_tarefa();
      select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(`select count(*) from public.event_log where organization_id='${ORG}'
        and event_type='ai.case_task_reminder_due' and entity_id='${CASE}' and payload->>'minute'='3'`),
    ).toBe(1);
    expect(
      number(`select count(*) from public.case_task_reminders r join public.event_log e
        on e.id=r.whatsapp_event_id and e.organization_id=r.organization_id
        where r.organization_id='${ORG}' and r.case_id='${CASE}' and r.minute=3`),
    ).toBe(1);

    for (const minute of [6, 9]) {
      sql(`update public.agent_cases set wait_started_at=clock_timestamp()-interval '${minute} minutes'
        where organization_id='${ORG}' and id='${CASE}'; select public.fn_processar_lembretes_tarefa();`);
    }
    expect(
      number(`select count(*) from public.event_log where organization_id='${ORG}'
        and event_type='ai.case_task_reminder_due' and entity_id='${CASE}'`),
    ).toBe(3);
    expect(
      number(`select count(*) from public.case_task_reminders where organization_id='${ORG}'
        and case_id='${CASE}' and result='notified' and whatsapp_event_id is not null`),
    ).toBe(3);
  });

  it("deduplica recibos iniciais e lembretes por patamar, preservando a chave de cada episódio", () => {
    reset("3 minutes");
    const initial = `insert into public.entregas_de_aviso_de_caso(organization_id,case_id,destino,status)
      values('${ORG}','${CASE}','+15555550101','pendente')`;
    sql(initial);
    expect(() => sql(initial)).toThrow();

    const reminder3 = `insert into public.entregas_de_aviso_de_caso
      (organization_id,case_id,destino,wait_generation,reminder_minute,status)
      values('${ORG}','${CASE}','+15555550101',123,3,'pendente')`;
    sql(reminder3);
    expect(() => sql(reminder3)).toThrow();
    sql(`insert into public.entregas_de_aviso_de_caso
      (organization_id,case_id,destino,wait_generation,reminder_minute,status) values
      ('${ORG}','${CASE}','+15555550101',123,6,'pendente'),
      ('${ORG}','${CASE}','+15555550101',124,3,'pendente')`);
    expect(() =>
      sql(`insert into public.entregas_de_aviso_de_caso
      (organization_id,case_id,destino,wait_generation,reminder_minute,status)
      values('${ORG}','${CASE}','+15555550101',125,null,'pendente')`),
    ).toThrow();
    expect(
      number(`select count(*) from public.entregas_de_aviso_de_caso where organization_id='${ORG}'
        and case_id='${CASE}' and destino='+15555550101'`),
    ).toBe(4);
  });
  it("avança3→6→9 no mesmo item da Central e nova espera ganha outro episódio", () => {
    reset("3 minutes");
    sql("select public.fn_processar_lembretes_tarefa();");
    const id = sql(
      `select id from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
    );
    for (const minute of [6, 9]) {
      sql(`update public.agent_cases set wait_started_at=clock_timestamp()-interval '${minute} minutes'
        where id='${CASE}' and organization_id='${ORG}'; select public.fn_processar_lembretes_tarefa();`);
      expect(
        sql(
          `select id from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
        ),
      ).toBe(id);
    }
    expect(
      number(
        `select count(*) from public.case_task_reminders where organization_id='${ORG}' and result='notified'`,
      ),
    ).toBe(3);
    sql(`update public.agent_cases set wait_generation=wait_generation+1,task_kind='payment_review',
      wait_started_at=clock_timestamp()-interval '3 minutes' where id='${CASE}' and organization_id='${ORG}';
      select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
      ),
    ).toBe(1);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}'`,
      ),
    ).toBe(2);
  });
  it("resolução fecha Central e impede aviso posterior", () => {
    reset("10 minutes");
    sql(`select public.fn_processar_lembretes_tarefa();
      update public.agent_cases set task_state='completed' where organization_id='${ORG}' and id='${CASE}';
      select public.fn_processar_lembretes_tarefa();`);
    expect(
      number(
        `select count(*) from public.agent_inbox_items where organization_id='${ORG}' and ref_id='${CASE}' and status='open'`,
      ),
    ).toBe(0);
  });
  it("proíbe cruzar organizações na FK e RPC não é executável por authenticated", () => {
    expect(
      number(
        `select has_function_privilege('authenticated','public.fn_processar_lembretes_tarefa(integer)','EXECUTE')::int`,
      ),
    ).toBe(0);
    expect(
      number(
        `select has_function_privilege('authenticated','public.fn_definir_aviso_de_caso_repeticao(uuid,uuid,text,text,boolean,boolean,boolean,boolean,smallint[])','EXECUTE')::int`,
      ),
    ).toBe(1);
    expect(
      number(
        `select has_function_privilege('anon','public.fn_definir_aviso_de_caso_repeticao(uuid,uuid,text,text,boolean,boolean,boolean,boolean,smallint[])','EXECUTE')::int`,
      ),
    ).toBe(0);
    expect(() =>
      sql(`insert into public.case_task_reminders(organization_id,case_id,wait_generation,minute,result)
      values('${ORG2}','${CASE}',999,3,'notified')`),
    ).toThrow();
    const withoutMembership = sql(
      "begin; set local role authenticated; select count(*) from public.case_task_reminders; rollback;",
    );
    expect(withoutMembership.split("\n").filter((line) => /^\d+$/.test(line))).toEqual(["0"]);
  });

  it("JWT de cada organização lê somente seus recibos, sem enxergar o vizinho", () => {
    sql(`
      insert into auth.users(id,email) values
        ('${USER}','task-reminders-1@invariant.test'),
        ('${USER2}','task-reminders-2@invariant.test') on conflict do nothing;
      insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
        ('${USER}','${ORG}','agent',now()),
        ('${USER2}','${ORG2}','agent',now()) on conflict do nothing;
      insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
        values('${CHANNEL2}','${ORG2}','task-reminders-other-0538','\\x00'::bytea) on conflict do nothing;
      insert into public.contacts(id,organization_id,display_name)
        values('${CONTACT2}','${ORG2}','Other contact') on conflict do nothing;
      insert into public.conversations(id,organization_id,contact_id,channel_session_id,status)
        values('${CONVERSATION2}','${ORG2}','${CONTACT2}','${CHANNEL2}','open') on conflict do nothing;
      insert into public.agent_cases(id,organization_id,conversation_id,status,source,title,summary,blocker)
        values('${CASE2}','${ORG2}','${CONVERSATION2}','awaiting_human','agent','Other task','summary','blocker') on conflict do nothing;
      insert into public.case_task_reminders(organization_id,case_id,wait_generation,minute,result) values
        ('${ORG}','${CASE}',999,3,'notified'),
        ('${ORG2}','${CASE2}',999,3,'notified') on conflict do nothing;
    `);
    const countsFor = (user: string) =>
      sql(`begin; set local role authenticated;
        select set_config('request.jwt.claims','{"sub":"${user}"}',false);
        select count(*) from public.case_task_reminders where organization_id='${ORG}';
        select count(*) from public.case_task_reminders where organization_id='${ORG2}';
        rollback;`)
        .split("\n")
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
    const tenantA = countsFor(USER);
    const tenantB = countsFor(USER2);
    expect(tenantA[0]).toBeGreaterThan(0);
    expect(tenantA[1]).toBe(0);
    expect(tenantB[0]).toBe(0);
    expect(tenantB[1]).toBeGreaterThan(0);
  });
});
