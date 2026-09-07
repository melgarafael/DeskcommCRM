import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";
const admin = "f2210000-0000-4000-8000-000000000001";
const member = "f2210000-0000-4000-8000-000000000002";
const a = "f2210000-0000-4000-8000-000000000003";
const b = "f2210000-0000-4000-8000-000000000004";
const seed = `begin;
insert into auth.users(id,email) values ('${admin}','admin221@local.test'),('${member}','member221@local.test');
insert into public.organizations(id,slug,display_name,legal_name) values ('${a}','a221','A','A'),('${b}','b221','B','B');
insert into public.user_organizations(organization_id,user_id,role,accepted_at) values ('${a}','${admin}','admin',now());`;
const accept = (org: string, settings: string) => `public.fn_accept_team_invite('${member}','${org}','agent','${admin}',now(),now(),'${settings}'::jsonb)`;
function prove(body: string) { expect(sql(`${seed}\n${body}\nrollback; select 'proved';`)).toContain("proved"); }
describe("interface por vínculo no banco aplicado", () => {
  it("mesma pessoa A/B tem escolhas independentes; replay não desfaz edição", () => prove(`
    select ${accept(a, '{"preset":"simplificada"}')};
    select ${accept(b, '{"preset":"completa"}')};
    update public.user_organizations set interface_settings='{"preset":"completa","destinos":["/app/tasks"]}' where organization_id='${a}' and user_id='${member}';
    select ${accept(a, '{"preset":"simplificada"}')};
    do $$ begin
      if (select interface_settings->'destinos' from public.user_organizations where organization_id='${a}' and user_id='${member}') <> '["/app/tasks"]'::jsonb then raise exception 'replay overwrote'; end if;
      if (select interface_settings from public.user_organizations where organization_id='${b}' and user_id='${member}') <> '{"preset":"completa"}'::jsonb then raise exception 'org leak'; end if;
    end $$;`));
  it("atendente não edita própria interface, admin A não edita B via RLS", () => prove(`
    select ${accept(a, '{"preset":"simplificada"}')}; select ${accept(b, '{"preset":"simplificada"}')};
    set local role authenticated;
    select set_config('request.jwt.claims','{"sub":"${member}"}',true);
    update public.user_organizations set interface_settings='{"preset":"completa"}' where organization_id='${a}' and user_id='${member}';
    select set_config('request.jwt.claims','{"sub":"${admin}"}',true);
    update public.user_organizations set interface_settings='{"preset":"completa"}' where organization_id='${b}' and user_id='${member}';
    reset role;
    do $$ begin if exists(select 1 from public.user_organizations where user_id='${member}' and interface_settings->>'preset'<>'simplificada') then raise exception 'unauthorized edit'; end if; end $$;`));
  it("reativação nova aplica interface, token antigo revogado não restaura", () => prove(`
    select ${accept(a, '{"preset":"completa"}')};
    update public.user_organizations set revoked_at=now()-interval '1 second' where organization_id='${a}' and user_id='${member}';
    select ${accept(a, '{"preset":"simplificada"}')};
    do $$ begin if (select interface_settings->>'preset' from public.user_organizations where organization_id='${a}' and user_id='${member}')<>'simplificada' then raise exception 'not reactivated'; end if; end $$;`));
  it("assinaturas antiga/nova permanecem service-only e coluna tem default", () => prove(`
    do $$ begin
     if has_function_privilege('authenticated','public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb)','execute') or has_function_privilege('anon','public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb)','execute') then raise exception 'exposed'; end if;
     if (select interface_settings from public.user_organizations where organization_id='${a}' and user_id='${admin}') <> '{"preset":"completa"}'::jsonb then raise exception 'default'; end if;
    end $$;`));
  it("criação do próprio responsável aplica interface sem alterar confiança do recibo", () => prove(`
    insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values ('${admin}','${admin}','full',false,'Local fixture');
    do $$ declare r jsonb; begin
      r := public.fn_create_tenant_with_owner('${admin}','${b}','{"display_name":"Nova","slug":"nova221","owner_email":"admin221@local.test","owner_interface_settings":{"preset":"simplificada"}}','abcd');
      if (select interface_settings->>'preset' from public.user_organizations where organization_id=(r->>'id')::uuid and user_id='${admin}')<>'simplificada' then raise exception 'owner interface lost'; end if;
      if not exists(select 1 from public.idempotency_keys where organization_id=(r->>'id')::uuid and tenant_creation_trusted) then raise exception 'untrusted'; end if;
    end $$;`));
});
