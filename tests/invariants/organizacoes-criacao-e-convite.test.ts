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
   * O CRIADOR PROVISÓRIO SAI NA ENTREGA (migration 0237).
   *
   * ⚠️ SEGUNDA TENTATIVA. A primeira deduzia a entrega de "existe outro admin
   * aceito" e, em produção, expulsou o dono do servidor da PRÓPRIA empresa —
   * uma organização que ele abriu para si e onde depois deu `admin` a um sócio.
   *
   * Agora a marca é GRAVADA na criação (`provisional_until_handover`), e só
   * quando o tenant é de outra pessoa. O caso que quebrou virou o primeiro
   * teste desta série, e ele é de SOBREVIVÊNCIA: prova que ninguém que não
   * devia sair, saiu.
   */
  it("SOBREVIVÊNCIA: organização própria com um SEGUNDO admin não perde o dono", () => prove(`
    do $$ declare org uuid; begin
      -- Exatamente a forma da empresa que quebrou: criada pela própria pessoa
      -- (como o /signup faz — sem passar por fn_create_tenant_with_owner),
      -- com um sócio que depois virou admin.
      insert into public.organizations(slug,display_name,legal_name,created_by)
        values ('propria-0237','Minha empresa','Minha empresa','${actor}') returning id into org;
      insert into public.user_organizations(organization_id,user_id,role,accepted_at)
        values (org,'${actor}','admin',now());
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'EXPULSOU O DONO DA PROPRIA EMPRESA — o defeito de 2026-09-11 voltou'; end if;
      if (select count(*) from public.user_organizations where organization_id=org) <> 2
        then raise exception 'a organizacao devia ter os dois admins'; end if;
    end $$;`));

  it("a marca só nasce quando o tenant é de OUTRA pessoa", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      if not (select provisional_until_handover from public.user_organizations
               where organization_id=org and user_id='${actor}')
        then raise exception 'tenant de terceiro e o vinculo nao nasceu provisorio'; end if;
    end $$;`));

  it("quem cria o PRÓPRIO tenant nasce SEM a marca, e nunca sai", () => prove(`
    do $$ declare r jsonb; org uuid; corpo jsonb; begin
      -- Mesmo payload, mas com o owner_email = o e-mail de quem cria.
      corpo := '{"display_name":"Minha","slug":"minha-0237","plan":"standard"}'::jsonb
             || jsonb_build_object('owner_email', (select email from auth.users where id='${actor}'));
      r := public.fn_create_tenant_with_owner('${actor}','f2180000-0000-4000-8000-0000000000aa', corpo, 'abcd');
      org := (r->>'id')::uuid;
      if (select provisional_until_handover from public.user_organizations
           where organization_id=org and user_id='${actor}')
        then raise exception 'criou para si e o vinculo nasceu provisorio'; end if;
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'saiu do proprio tenant'; end if;
    end $$;`));

  it("na entrega o provisório sai — e a organização não fica vazia", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      perform public.fn_accept_team_invite('${guest}',org,'admin','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 0
        then raise exception 'o provisorio ficou'; end if;
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${guest}' and role='admin' and revoked_at is null) <> 1
        then raise exception 'o dono nao assumiu'; end if;
      -- A ordem: o vínculo do dono é gravado ANTES de o provisório sair.
      if (select count(*) from public.user_organizations where organization_id=org and revoked_at is null) < 1
        then raise exception 'organizacao ficou vazia'; end if;
    end $$;`));

  it("papel que não é o do dono não dispara a entrega", () => prove(`
    do $$ declare r jsonb; org uuid; begin
      r := ${call}; org := (r->>'id')::uuid;
      perform public.fn_accept_team_invite('${guest}',org,'agent','${actor}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      if (select count(*) from public.user_organizations where organization_id=org and user_id='${actor}') <> 1
        then raise exception 'um colega entrando expulsou o provisorio'; end if;
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
