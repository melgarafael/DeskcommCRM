import { describe, it, expect } from "vitest";
import { sql } from "./gov-helpers";

const actor = "f2190000-0000-4000-8000-000000000001";
const attacker = "f2190000-0000-4000-8000-000000000002";
const org = "f2190000-0000-4000-8000-000000000003";
const victim = "f2190000-0000-4000-8000-000000000004";
const key = "f2190000-0000-4000-8000-000000000005";
const endpoint = `/api/v1/admin/tenants:${actor}`;
const call = `public.fn_create_tenant_with_owner('${actor}','${key}','{"display_name":"Recibo","slug":"recibo-0219","plan":"standard"}', 'abcd')`;
const seed = `begin;
insert into auth.users(id,email) values ('${actor}','owner-0219@invariant.test'),('${attacker}','attacker-0219@invariant.test');
insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values ('${actor}','${actor}','full',false,'Local invariant fixture');
insert into public.organizations(id,slug,display_name,legal_name) values ('${org}','attacker-0219','Attacker','Attacker'),('${victim}','victim-0219','Victim','Victim');
insert into public.user_organizations(organization_id,user_id,role,accepted_at) values ('${org}','${attacker}','viewer',now());`;
const asAttacker = `set local role authenticated; select set_config('request.jwt.claims','{"sub":"${attacker}"}',true);`;
const receipt = `(organization_id,key,endpoint,request_hash,status_code,response_body)`;
function prove(body: string) { expect(sql(`${seed}\n${body}\nrollback; select 'proved';`)).toContain("proved"); }

describe("recibo administrativo só tem autoridade quando produzido pelo servidor", () => {
  it("recibo anterior forjado não escolhe alvo; criação e replay confiáveis conservam org, convite e instante", () => prove(`
    insert into public.idempotency_keys ${receipt} values ('${org}','${key}','${endpoint}',decode('abcd','hex'),201,
      jsonb_build_object('id','${victim}','invite_id','${key}','issued_at',9999999999));
    do $$ declare r jsonb; again jsonb; begin
      r := ${call}; again := ${call};
      if r->>'id' in ('${victim}','${org}') or not (r->>'created')::boolean then raise exception 'forged receipt trusted'; end if;
      if again <> r || jsonb_build_object('created',false) then raise exception 'unstable replay'; end if;
      if (select count(*) from public.idempotency_keys where key='${key}' and tenant_creation_trusted) <> 1 then raise exception 'missing trusted provenance'; end if;
      if not exists(select 1 from public.idempotency_keys where organization_id='${org}' and key='${key}' and not tenant_creation_trusted) then raise exception 'old receipt destroyed'; end if;
    end $$;`));

  it("membro não insere namespace reservado nem marker verdadeiro e não promove recibo comum", () => prove(`
    ${asAttacker}
    do $$ begin
      begin insert into public.idempotency_keys ${receipt} values ('${org}','reserved','${endpoint}',decode('abcd','hex'),201,'{}');
        raise exception 'reserved insert allowed'; exception when insufficient_privilege then null; end;
      begin insert into public.idempotency_keys (organization_id,key,endpoint,request_hash,status_code,response_body,tenant_creation_trusted) values ('${org}','trusted','ordinary',decode('abcd','hex'),201,'{}',true);
        raise exception 'trusted insert allowed'; exception when insufficient_privilege then null; end;
      insert into public.idempotency_keys ${receipt} values ('${org}','normal','ordinary',decode('abcd','hex'),201,'{}');
      begin update public.idempotency_keys set tenant_creation_trusted=true where key='normal';
        raise exception 'promotion allowed'; exception when insufficient_privilege then null; end;
      begin update public.idempotency_keys set endpoint='${endpoint}' where key='normal';
        raise exception 'rename into reserved allowed'; exception when insufficient_privilege then null; end;
    end $$;`));

  it("membro não lê, altera, rebaixa, renomeia ou apaga recibo protegido, nem trunca a tabela", () => prove(`
    insert into public.idempotency_keys (organization_id,key,endpoint,request_hash,status_code,response_body,tenant_creation_trusted) values ('${org}','trusted','${endpoint}',decode('abcd','hex'),201,'{}',true),('${org}','legacy','${endpoint}',decode('abcd','hex'),201,'{}',false);
    ${asAttacker}
    do $$ declare n integer; begin
      if exists(select 1 from public.idempotency_keys where key in ('trusted','legacy')) then raise exception 'reserved read allowed'; end if;
      update public.idempotency_keys set response_body='{"id":"${victim}"}' where key in ('trusted','legacy');
      get diagnostics n = row_count; if n <> 0 then raise exception 'tampering allowed'; end if;
      update public.idempotency_keys set tenant_creation_trusted=false,endpoint='ordinary' where key in ('trusted','legacy');
      get diagnostics n = row_count; if n <> 0 then raise exception 'rename escape allowed'; end if;
      delete from public.idempotency_keys where key in ('trusted','legacy');
      get diagnostics n = row_count; if n <> 0 then raise exception 'deletion allowed'; end if;
      begin truncate public.idempotency_keys; raise exception 'truncate allowed'; exception when insufficient_privilege then null; end;
    end $$;`));

  it("namespaces MCP e LGPD conservam INSERT/read/update/delete e isolamento", () => prove(`
    ${asAttacker}
    do $$ declare e text; n integer; begin
      foreach e in array array['mcp:crm_send_whatsapp_message','/api/v1/lgpd/requests/${key}/approve'] loop
        insert into public.idempotency_keys ${receipt} values ('${org}','compat',e,decode('abcd','hex'),202,'{"ok":true}');
        if (select response_body->>'ok' from public.idempotency_keys where key='compat' and endpoint=e) <> 'true' then raise exception 'read broken'; end if;
        update public.idempotency_keys set status_code=200 where key='compat' and endpoint=e;
        get diagnostics n = row_count; if n <> 1 then raise exception 'update broken'; end if;
        delete from public.idempotency_keys where key='compat' and endpoint=e;
        get diagnostics n = row_count; if n <> 1 then raise exception 'delete broken'; end if;
        begin insert into public.idempotency_keys ${receipt} values ('${victim}','cross',e,decode('abcd','hex'),201,'{}');
          raise exception 'cross tenant allowed'; exception when insufficient_privilege then null; end;
      end loop;
    end $$;`));
});
