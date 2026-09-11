import { describe, it, expect } from "vitest";
import { sql } from "./gov-helpers";

const actor = "f2180000-0000-4000-8000-000000000001";
const guest = "f2180000-0000-4000-8000-000000000002";
const key = "f2180000-0000-4000-8000-000000000003";
const body = `' {"display_name":"Nova organização", "slug":"invariante-0218", "plan":"standard"}'::jsonb`;
const call = `public.fn_create_tenant_with_owner('${actor}', '${key}', ${body}, 'abcd')`;
const seed = `begin;
insert into auth.users(id,email) values ('${actor}','owner-0218@invariant.test'), ('${guest}','guest-0218@invariant.test');
insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values ('${actor}','${actor}','full',false,'Local invariant fixture');`;
function prove(body: string) { expect(sql(`${seed}\n${body}\nrollback; select 'proved';`)).toContain("proved"); }

describe("organização criada leva acesso e convite seguro", () => {
  it("cria org + membership admin e repete a mesma chave sem duplicar", () => prove(`
    do $$ declare r jsonb; repeated jsonb; begin
      r := ${call}; repeated := ${call};
      if r->>'id' <> repeated->>'id' or (repeated->>'created')::boolean then raise exception 'duplicated'; end if;
      if (select count(*) from public.user_organizations where organization_id=(r->>'id')::uuid and user_id='${actor}' and role='admin' and accepted_at is not null) <> 1 then raise exception 'no owner'; end if;
      if (select count(*) from public.organizations where slug='invariante-0218') <> 1 then raise exception 'duplicate organization'; end if;
    end $$;`));

  it("falha na membership faz rollback da organização", () => prove(`
    create function pg_temp.reject_owner() returns trigger language plpgsql as $$ begin raise exception 'simulated membership failure'; end $$;
    create trigger reject_owner before insert on public.user_organizations for each row execute function pg_temp.reject_owner();
    do $$ begin
      begin perform ${call}; raise exception 'should have failed';
      exception when others then if sqlerrm <> 'simulated membership failure' then raise; end if; end;
      if exists(select 1 from public.organizations where slug='invariante-0218') then raise exception 'orphan'; end if;
    end $$;`));

  it("mesma chave com payload diferente não altera nem cria outra org", () => prove(`
    select ${call};
    do $$ begin
      begin perform public.fn_create_tenant_with_owner('${actor}','${key}',${body},'cdef'); raise exception 'accepted mismatch';
      exception when invalid_parameter_value then null; end;
    end $$;`));

  it("support_readonly não cria; RPCs não são expostas ao cliente", () => prove(`
    update public.platform_admins set scope='support_readonly' where user_id='${actor}';
    do $$ begin
      begin perform ${call}; raise exception 'readonly created'; exception when insufficient_privilege then null; end;
      if has_function_privilege('authenticated','public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text)','execute') or
        has_function_privilege('anon','public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz)','execute') then raise exception 'rpc exposed'; end if;
    end $$;`));

  it("convite preserva convidador; replay não restaura admin rebaixado/revogado", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute');
      if (select invited_by from public.user_organizations where user_id='${guest}' and organization_id=org) <> '${actor}' then raise exception 'inviter lost'; end if;
      update public.user_organizations set role='viewer' where user_id='${guest}' and organization_id=org;
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute');
      if (select role from public.user_organizations where user_id='${guest}' and organization_id=org) <> 'viewer' then raise exception 'role restored'; end if;
      update public.user_organizations set revoked_at=now() where user_id='${guest}' and organization_id=org;
      begin perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute');
        raise exception 'revocation restored'; exception when insufficient_privilege then null; end;
      begin perform public.fn_accept_team_invite('${guest}',org,'admin',null,null,now()-interval '1 minute');
        raise exception 'legacy restored revocation'; exception when insufficient_privilege then null; end;
    end $$;`));

  /**
   * O CRIADOR SAI QUANDO O DONO ASSUME (migration 0237).
   *
   * `fn_create_tenant_with_owner` inscreve o criador como admin aceito — e é
   * necessário, senão a organização nasce sem ninguém dentro. O que faltava era
   * a saída: nada nunca o tirava de lá, e numa revenda o cliente encontrava o
   * e-mail pessoal do revendedor listado como colega na própria Equipe.
   *
   * O instante da saída é a entrega: o dono aceitar o convite. Antes dele a
   * organização precisa de alguém; depois dele o criador não tem o que fazer.
   */
  it("o criador SAI quando o dono assume — e a organização não fica vazia", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'criador nao entrou na criacao'; end if;
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 0
        then raise exception 'criador continuou no tenant do cliente'; end if;
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${guest}' and role='admin' and revoked_at is null) <> 1
        then raise exception 'dono nao assumiu'; end if;
      -- A ordem importa: o vínculo do dono é gravado ANTES de o criador sair.
      -- Invertida, existiria um instante com a organização sem ninguém.
      if (select count(*) from public.user_organizations where organization_id=org and revoked_at is null) < 1
        then raise exception 'organizacao ficou vazia'; end if;
    end $$;`));

  it("papel que NÃO é o do dono não expulsa o criador — colega entrando não é entrega", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      perform public.fn_accept_team_invite('${guest}',org,'agent','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'criador saiu por um convite que nao era a entrega'; end if;
    end $$;`));

  it("vínculo que veio de CONVITE não é confundido com o da criação", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      -- O criador passa a ter vínculo de convite aceito (invited_at preenchido):
      -- deixa de casar com a regra, que só alcança quem entrou pela criação.
      update public.user_organizations set invited_at = now() - interval '2 minutes'
        where organization_id=org and user_id='${actor}';
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'expulsou quem tinha convite de verdade'; end if;
    end $$;`));

  it("criador que NÃO é platform admin não é tocado", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      update public.platform_admins set revoked_at = now() where user_id='${actor}';
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'regra alcancou quem nao e dono do servidor'; end if;
    end $$;`));

  it("convidado só enxerga organização aceita, com RLS real", () => prove(`
    select ${call};
    insert into public.organizations(slug,display_name,legal_name) values ('outra-0218','Outra','Outra');
    select public.fn_accept_team_invite('${guest}', (select id from public.organizations where slug='invariante-0218'),'agent','${actor}',now(),now());
    set local role authenticated;
    select set_config('request.jwt.claims','{"sub":"${guest}"}',true);
    do $$ begin
      if (select count(*) from public.organizations where slug in ('invariante-0218','outra-0218')) <> 1 then raise exception 'tenant leak'; end if;
    end $$;`));
});
