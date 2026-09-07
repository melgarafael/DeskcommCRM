import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";
const actor = "f2200000-0000-4000-8000-000000000001";
const session = "f2200000-0000-4000-8000-000000000002";
const other = "f2200000-0000-4000-8000-000000000003";
const a = "f2200000-0000-4000-8000-000000000004";
const b = "f2200000-0000-4000-8000-000000000005";
const contact = "f2200000-0000-4000-8000-000000000006";
const seed = `begin;
insert into auth.users(id,email) values('${actor}','support@invariant.test');
insert into auth.sessions(id,user_id,aal) values('${session}','${actor}','aal1'),('${other}','${actor}','aal1');
insert into organizations(id,slug,display_name,legal_name) values('${a}','support-a','A','A'),('${b}','support-b','B','B');
insert into user_organizations(organization_id,user_id,role,accepted_at) values('${a}','${actor}','admin',now());
insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values('${actor}','${actor}','full',false,'Local test');
insert into contacts(id,organization_id,name) values('${contact}','${b}','Original B');`;
const claims = (id=session,aal="aal1") => `select set_config('request.jwt.claims','{"sub":"${actor}","session_id":"${id}","aal":"${aal}"}',true);`;
const start = (mode="full",ttl=3600) => `select fn_start_support('${actor}','${session}','${b}','${a}','${mode}',${ttl});`;
const assert = (condition:string) => `do $$ begin if (${condition}) is distinct from true then raise exception 'assertion failed: %',${JSON.stringify(condition).replaceAll("'","''").replace(/^"|"$/g,"'")}; end if; end $$;`;
function prove(body:string) { expect(sql(`${seed}\n${body}\nrollback; select 'proved';`)).toContain("proved"); }
const denied = (statement:string) => `do $$ begin begin ${statement}; raise exception 'write escaped'; exception when insufficient_privilege then null; end; end $$;`;

describe("suporte temporário vinculado à sessão real",()=>{
 it("full concede B sem membership e mantém A; TTL tem teto no corpo",()=>prove(`${start("full",999999)} ${claims()}
 ${assert(`fn_support_context()->>'status'='active' and fn_user_role_in_org('${b}')='admin'`)}
 ${assert(`(select count(*) from fn_user_org_ids())=2`)}
 ${assert(`not exists(select 1 from user_organizations where organization_id='${b}')`)}
 ${assert(`(select expires_at-created_at <= interval '1 hour' from platform_support_sessions)`)}
 set local role authenticated; update contacts set name='Full B' where id='${contact}';
 ${assert(`(select name='Full B' from contacts where id='${contact}')`)}
 ${assert(`fn_member_role_in_org('${actor}','${b}') is null`)}
 `));
 it("sessão distinta do mesmo ator não recebe grant nem restrição",()=>prove(`${start("support_readonly")} ${claims(other)}
 ${assert(`fn_support_context() is null and fn_user_role_in_org('${b}') is null and fn_support_write_allowed('${b}')`)}
 `));
 for(const physical of [false,true]) it(`readonly derrota DML/permissiva de plataforma (membership B=${physical})`,()=>prove(`
 ${physical?`insert into user_organizations(organization_id,user_id,role,accepted_at) values('${b}','${actor}','admin',now());`:""}
 ${start("support_readonly")} ${claims()}
 ${assert(`fn_user_role_in_org('${b}')='viewer' and not fn_support_write_allowed('${b}') and fn_support_write_allowed('${a}')`)}
 set local role authenticated;
 ${denied(`insert into contacts(organization_id,name) values('${b}','Forbidden')`)}
 update contacts set name='Forbidden' where id='${contact}';
 ${assert(`(select name='Original B' from contacts where id='${contact}')`)}
 delete from contacts where id='${contact}';
 ${assert(`exists(select 1 from contacts where id='${contact}')`)}
 update organizations set display_name='Forbidden' where id='${b}';
 ${assert(`(select display_name='B' from organizations where id='${b}')`)}
 insert into contacts(organization_id,name) values('${a}','Allowed A');
 ${denied(`update contacts set organization_id='${b}' where organization_id='${a}' and name='Allowed A'`)}
 `));
 for(const statement of [
 `perform emit_event('test.event','contact','${contact}','{}','{}','${b}')`,
 `perform fn_log_event('${b}','test.event','{}')`,
 `perform fn_conversation_assign('${b}','${contact}',null,'manual')`,
 `perform fn_mesclar_contatos('${b}','${contact}',array['${contact}']::uuid[])`,
 ]) it(`RPC readonly recusa antes do efeito: ${statement.split('(')[0]}`,()=>prove(`${start("support_readonly")} ${claims()} set local role authenticated; ${denied(statement)}`));
 it("emissão sem org durante full aponta B; modo atual só reduz",()=>prove(`${start()} ${claims()}
 select emit_event('test.event','contact','${contact}');
 ${assert(`exists(select 1 from event_log where organization_id='${b}' and event_type='test.event')`)}
 update platform_admins set scope='support_readonly' where user_id='${actor}';
 ${assert(`fn_user_role_in_org('${b}')='viewer' and not fn_support_write_allowed('${b}')`)}
 `));
 for(const invalidation of ["update platform_support_sessions set expires_at=now()-interval '1 second'",`update platform_admins set revoked_at=now() where user_id='${actor}'`,`delete from auth.sessions where id='${session}'`]) it(`invalidade permanece até saída: ${invalidation.split(' ')[1]}`,()=>prove(`${start()} ${claims()}
 ${invalidation};
 ${assert(`fn_support_context()->>'status'<>'active' and not fn_support_write_allowed('${b}') and fn_user_role_in_org('${b}') is null`)}
 select fn_end_support('${actor}','${session}');
 ${assert(`fn_support_context() is null and fn_support_write_allowed('${b}')`)}
 `));
 it("MFA é medida no Auth, não só na UI",()=>prove(`update platform_admins set mfa_required=true where user_id='${actor}';
 do $$ begin begin perform fn_start_support('${actor}','${session}','${b}','${a}'); raise exception 'MFA escaped'; exception when others then if sqlerrm<>'support_authority_required' then raise; end if; end; end $$;
 update auth.sessions set aal='aal2' where id='${session}'; ${start()} ${claims(session,"aal2")}
 ${assert(`fn_support_context()->>'status'='active'`)} ${claims()}
 ${assert(`fn_support_context()->>'status'='revoked'`)}
 `));
 it("callback novo revalida sessão; legado recusa ambiguidades readonly; worker continua",()=>prove(`${start("support_readonly")}
 ${assert(`not fn_support_callback_write_allowed('${b}','${actor}','${session}') and fn_support_callback_write_allowed('${b}','${actor}','${other}') and not fn_support_callback_write_allowed('${b}')`)}
 set local role service_role;
 insert into contacts(organization_id,name) values('${b}','Real worker');
 ${assert(`exists(select 1 from contacts where organization_id='${b}' and name='Real worker')`)}
 `));
 it("sessões são server-only; não se forjam grants via PostgREST",()=>{
 expect(sql(`select has_table_privilege('authenticated','public.platform_support_sessions','insert') or has_table_privilege('authenticated','public.platform_support_sessions','update') or has_table_privilege('authenticated','public.platform_support_sessions','delete');`)).toBe("f");
 });
 it("catálogo real não deixa tabela tenant gravável sem cerca restritiva",()=>{
 const result=sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'
 and (has_table_privilege('authenticated',c.oid,'insert') or has_table_privilege('authenticated',c.oid,'update') or has_table_privilege('authenticated',c.oid,'delete'))
 and (c.relname='organizations' or exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='organization_id'))
 and (select count(*) from pg_policy p where p.polrelid=c.oid and not p.polpermissive and p.polname like 'support_write_%')<>3;`);
 expect(result).toBe("0");
 });
});
