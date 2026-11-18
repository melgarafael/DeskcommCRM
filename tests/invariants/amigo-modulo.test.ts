import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * MÓDULO OPCIONAL `amigo` (migration 9393, #4227 etapa 2 de 2 do doc 356).
 *
 * Contra o banco real com o `baseline.sql` aplicado. Cada sonda reaplica a
 * migration (idempotência), instala as tabelas pela provisionadora e desfaz
 * tudo no `rollback`. Duas organizações, A e B, em todas as sondas: o
 * isolamento entre elas é o que mais importa aqui.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER required");
const migrationPath = `supabase/migrations/${readdirSync("supabase/migrations").find(f => f.endsWith("_9393_modulo_amigo.sql"))}`;
const migration = readFileSync(migrationPath, "utf8");
const a = "aa000000-0000-4000-8000-000000000001", b = "aa000000-0000-4000-8000-000000000002";
const admin = "aa000000-0000-4000-8000-000000000011", manager = "aa000000-0000-4000-8000-000000000012", agent = "aa000000-0000-4000-8000-000000000013";
const ca = "aa000000-0000-4000-8000-000000000021", cb = "aa000000-0000-4000-8000-000000000022";
const contactA = "aa000000-0000-4000-8000-000000000031", contactB = "aa000000-0000-4000-8000-000000000032";
function sql(body: string, seed = true): string {
  return execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-qtA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8", input: `begin;\n${migration}\n${seed ? fixtures : ""}\n${body}\nrollback;`, stdio: ["pipe", "pipe", "pipe"],
  }).trim().split("\n").at(-1)!;
}
const fixtures = `
select public.fn_amigo_provisionar();
insert into public.modulos_instalados(modulo,estado) values ('amigo','ativo') on conflict (modulo) do update set estado='ativo';
insert into public.organizations(id,slug,legal_name,display_name) values ('${a}','amigo-probe-a','A','A'),('${b}','amigo-probe-b','B','B');
insert into auth.users(id,email) values ('${admin}','admin@amigo.invariant.test'),('${manager}','manager@amigo.invariant.test'),('${agent}','agent@amigo.invariant.test');
insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${admin}','${a}','admin',now()),('${manager}','${a}','manager',now()),('${agent}','${a}','agent',now());
insert into public.amigo_connections(id,organization_id,token_last4,validated_at,timezone) values ('${ca}','${a}','1234',now(),'America/Fortaleza'),('${cb}','${b}','5678',now(),'America/Fortaleza');
insert into public.amigo_credentials(connection_id,organization_id,ciphertext) values ('${ca}','${a}','ciphertext-ficticio'),('${cb}','${b}','ciphertext-ficticio');
insert into public.contacts(id,organization_id,name) values ('${contactA}','${a}','Fictício A'),('${contactB}','${b}','Fictício B');
insert into public.amigo_patient_links(organization_id,connection_id,patient_id,contact_id) values ('${a}','${ca}',1,'${contactA}'),('${b}','${cb}',1,'${contactB}');
insert into public.amigo_appointment_links(organization_id,connection_id,attendance_id,patient_id,remote_data) values ('${a}','${ca}',1,1,'{"private":"a"}'),('${b}','${cb}',1,1,'{"private":"b"}');
`;
function denied(statement: string, code = "42501") {
  return `do $probe$ begin begin ${statement}; exception when sqlstate '${code}' then return; end; raise exception 'Expected SQLSTATE ${code}'; end $probe$; select 'ok';`;
}
function asUser(user: string, statement: string) { return `set local role authenticated; select set_config('request.jwt.claims','{"sub":"${user}"}',true); ${statement}`; }

describe("Amigo optional SQL and tenant boundaries", () => {
  it("a migration não cria tabela nenhuma sem instalar o módulo, reaplica sem erro e está no baseline", () => {
    expect(readFileSync("supabase/baseline.sql", "utf8")).toContain(migration.split("\n").slice(1).join("\n"));
    expect(sql(`${migration}\nselect to_regclass('public.amigo_connections') is null and to_regclass('public.amigo_patient_links') is null;`, false)).toBe("t");
  });
  it("a instalação pela porta oficial (fn_modulo_instalar) cria as tabelas e o módulo fica ativo", () => {
    expect(sql(`insert into auth.users(id,email) values ('${admin}','admin@amigo.invariant.test');
      insert into public.platform_admins(user_id, granted_by, scope, mfa_required, reason) values ('${admin}','${admin}','full',false,'Teste do módulo amigo') on conflict (user_id) do update set revoked_at=null, scope='full';
      select public.fn_modulo_instalar('${admin}', gen_random_uuid(), 'amigo');
      select to_regclass('public.amigo_connections') is not null
        and exists(select 1 from public.modulos_instalados where modulo='amigo' and estado='ativo');`, false)).toBe("t");
  });
  it("com o módulo fora de modulos_instalados, salvar configuração é recusado mesmo pelo servidor", () => {
    expect(sql(`delete from public.modulos_instalados where modulo='amigo'; set local role service_role; ${denied(`perform public.fn_amigo_save_config('${a}','${admin}','{}',null)`, "22023")}`)).toBe("ok");
  });
  it("LGPD: anonimizar o contato apaga o vínculo dele e redige o espelho; a outra organização fica intacta", () => {
    expect(sql(`update public.contacts set is_anonymized=true, anonymized_at=now() where id='${contactA}';
      select (not exists(select 1 from public.amigo_patient_links where contact_id='${contactA}'))
        and (select remote_data='{}'::jsonb from public.amigo_appointment_links where organization_id='${a}')
        and (select remote_data='{"private":"b"}'::jsonb from public.amigo_appointment_links where organization_id='${b}')
        and exists(select 1 from public.amigo_patient_links where contact_id='${contactB}');`)).toBe("t");
  });
  it("LGPD: o recibo de operação do paciente anonimizado é redigido, o de outro paciente não", () => {
    const op = (key: string, ctx: string) => `insert into public.amigo_operations(organization_id,connection_id,key,request_hash,operation,state,target_id,result,request_context) values ('${a}','${ca}','${key}','h','attendance_create','confirmed','t-${key}','{"data":{"name":"Fulana"}}','${ctx}')`;
    expect(sql(`${op("k1", '{"patient_id":1}')}; ${op("k2", '{"patient_id":2}')};
      update public.contacts set is_anonymized=true, anonymized_at=now() where id='${contactA}';
      select (select result='{"redacted":true}'::jsonb and request_context='{}'::jsonb from public.amigo_operations where key='k1')
        and (select result->'data'->>'name'='Fulana' from public.amigo_operations where key='k2');`)).toBe("t");
  });
  it("provisioner can be invoked twice by service_role", () => {
    expect(sql("set local role service_role; select public.fn_amigo_provisionar(); select public.fn_amigo_provisionar(); select 'ok';", false)).toBe("ok");
  });
  for (const role of ["anon", "authenticated"]) {
    it(`${role} cannot provision or read credentials`, () => {
      expect(sql(`set local role ${role}; ${denied("perform public.fn_amigo_provisionar()")}`)).toBe("ok");
      expect(sql(`set local role ${role}; ${denied("perform ciphertext from public.amigo_credentials")}`)).toBe("ok");
    });
  }
  it("manager sees safe config and links only in own org; agent cannot read global remote_data", () => {
    expect(sql(asUser(manager, "select count(*) from public.amigo_connections;"))).toBe("1");
    expect(sql(asUser(manager, "select count(*) from public.amigo_appointment_links;"))).toBe("1");
    expect(sql(asUser(agent, "select count(*) from public.amigo_connections;"))).toBe("0");
    expect(sql(asUser(agent, "select count(*) from public.amigo_appointment_links;"))).toBe("0");
    expect(sql(asUser(manager, `select count(*) from public.amigo_patient_links where organization_id='${b}';`))).toBe("0");
    // Recibos: a gestão de A lê o de A (contagem positiva antes da recusa) e nunca o de B.
    const ops = `insert into public.amigo_operations(organization_id,connection_id,key,request_hash,operation,target_id) values ('${a}','${ca}','ka','h','places','t-a'),('${b}','${cb}','kb','h','places','t-b');`;
    expect(sql(`${ops} ${asUser(manager, "select count(*) from public.amigo_operations;")}`)).toBe("1");
    expect(sql(`${ops} ${asUser(manager, `select count(*) from public.amigo_operations where organization_id='${b}';`)}`)).toBe("0");
  });
  it("authenticated admin cannot write through PostgREST tables or privileged RPC", () => {
    expect(sql(asUser(admin, denied(`update public.amigo_connections set active=false where organization_id='${a}'`)))).toBe("ok");
    expect(sql(asUser(admin, denied(`perform public.fn_amigo_disconnect('${a}')`)))).toBe("ok");
  });
  it("rejects connection/contact/lead/appointment foreign tenant references", () => {
    expect(sql(denied(`insert into public.amigo_patient_links(organization_id,connection_id,patient_id,contact_id) values ('${a}','${cb}',2,'${contactA}')`, "23503"))).toBe("ok");
    expect(sql(denied(`insert into public.amigo_patient_links(organization_id,connection_id,patient_id,contact_id) values ('${a}','${ca}',2,'${contactB}')`, "23503"))).toBe("ok");
    expect(sql(denied(`insert into public.amigo_appointment_links(organization_id,connection_id,attendance_id,appointment_id) values ('${a}','${ca}',2,'${contactB}')`, "23503"))).toBe("ok");
  });
  it("enforces positive external ids, month range, and only one active connection", () => {
    expect(sql(denied(`insert into public.amigo_patient_links(organization_id,connection_id,patient_id,contact_id) values ('${a}','${ca}',0,'${contactA}')`, "23514"))).toBe("ok");
    expect(sql(denied(`update public.amigo_connections set months_ahead=4 where id='${ca}'`, "23514"))).toBe("ok");
    expect(sql(`update public.amigo_connections set active=true,default_place_id=7 where id='${ca}'; ${denied(`insert into public.amigo_connections(organization_id,active,token_last4,validated_at,default_place_id,timezone) values ('${a}',true,'1234',now(),7,'UTC')`, "23505")}`)).toBe("ok");
  });
  it("cannot activate missing validation/unit/timezone", () => {
    expect(sql(denied(`update public.amigo_connections set active=true where id='${ca}'`, "23514"))).toBe("ok");
    expect(sql(denied(`update public.amigo_connections set timezone='invalid/timezone' where id='${ca}'`, "23514"))).toBe("ok");
  });
  it("replaces connection atomically, preserves history, and does not inherit unit/options", () => {
    expect(sql(`set local role service_role; select public.fn_amigo_save_config('${a}','${admin}','{"token_last4":"9999"}', 'new-cipher'); reset role; select count(*)=2 and count(*) filter(where active)=0 from public.amigo_connections where organization_id='${a}';`)).toBe("t");
    expect(sql(`set local role service_role; select public.fn_amigo_save_config('${a}','${admin}','{"token_last4":"9999"}', 'new-cipher'); reset role; select count(*) from public.amigo_patient_links where connection_id='${ca}';`)).toBe("1");
  });
  it("stale configuration identity cannot activate a replaced connection", () => {
    expect(sql(`set local role service_role; ${denied(`perform public.fn_amigo_save_config('${a}','${admin}','{\"active\":true}',null,'${cb}')`, "40001")}`)).toBe("ok");
  });
  it("failed replacement leaves the previous active connection and credential intact", () => {
    expect(sql(`update public.amigo_connections set active=true,default_place_id=7 where id='${ca}'; set local role service_role; ${denied(`perform public.fn_amigo_save_config('${a}','${admin}','{\"token_last4\":\"9999\",\"timezone\":\"invalid/timezone\"}', 'new-cipher')`, "23514")} reset role; select active from public.amigo_connections where id='${ca}';`)).toBe("t");
  });
  it("service write requires a current admin actor in the target org", () => {
    expect(sql(`set local role service_role; ${denied(`perform public.fn_amigo_save_config('${b}','${admin}','{}',null)`)}`)).toBe("ok");
    expect(sql(`set local role service_role; ${denied(`perform public.fn_amigo_save_config('${a}','${agent}','{}',null)`)}`)).toBe("ok");
  });
  it("disconnect removes secrets, deactivates and preserves historical links", () => {
    expect(sql(`set local role service_role; select public.fn_amigo_disconnect('${a}'); reset role; select (not exists(select 1 from public.amigo_credentials where organization_id='${a}')) and (select count(*)=1 from public.amigo_patient_links where organization_id='${a}') and (not exists(select 1 from public.amigo_connections where organization_id='${a}' and (active or token_last4 is not null)));`)).toBe("t");
  });
  it("operation key is unique and different keys cannot mutate same in-flight target", () => {
    const insert = (key: string, target: string, state = "prepared") => `insert into public.amigo_operations(organization_id,connection_id,key,request_hash,operation,state,target_id) values ('${a}','${ca}','${key}','hash','confirmAttendance','${state}','${target}')`;
    expect(sql(`${insert("key-1","attendance:1")}; ${denied(insert("key-1","attendance:2"), "23505")}`)).toBe("ok");
    expect(sql(`${insert("key-1","attendance:1")}; ${denied(insert("key-2","attendance:1"), "23505")}`)).toBe("ok");
    expect(sql(`${insert("key-1","request:hash","uncertain")}; ${denied(insert("key-2","request:hash"), "23505")}`)).toBe("ok");
    expect(sql(`${insert("key-1","attendance:1","confirmed")}; ${insert("key-2","attendance:1")}; select 'ok';`)).toBe("ok");
  });
});
