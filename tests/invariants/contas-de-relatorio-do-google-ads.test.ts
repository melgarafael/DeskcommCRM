import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

describe("credenciais de leitura de anunciantes do Google Ads", () => {
  it("fecha a tabela e os tokens aos clientes do PostgREST", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.google_ads_reporting_accounts'::regclass;`)).toBe("t");
    const consulta = (papel: string) => sql(`
      select string_agg(has_table_privilege('${papel}', 'public.google_ads_reporting_accounts', p)::text, ',' order by p)
      from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p;`);
    expect(consulta("anon")).toBe("false,false,false,false");
    expect(consulta("authenticated")).toBe("false,false,false,false");
    expect(consulta("service_role")).toBe("true,true,true,true");
    for (const papel of ["anon", "authenticated"]) {
      expect(sql(`select has_function_privilege('${papel}', 'public.fn_google_ads_admin_do_relatorio(uuid,uuid,uuid,uuid)', 'execute');`)).toBe("f");
    }
  });

  it("o papel precisa continuar válido na sessão que começou a conexão", () => {
    const org = "ba000000-9433-4000-8000-000000000003";
    const ator = "ba000000-9433-4000-8000-000000000004";
    const sessao = "ba000000-9433-4000-8000-000000000005";
    const conferir = `select 'admin:' || public.fn_google_ads_admin_do_relatorio('${org}','${ator}','${sessao}',null)::text;`;
    const linhas = sql(`
      begin;
      insert into public.organizations(id, slug, legal_name, display_name) values ('${org}','relatorio-admin','A','A');
      insert into auth.users(id,email) values ('${ator}','relatorio-admin@invariant.test');
      insert into auth.sessions(id,user_id,aal) values ('${sessao}','${ator}','aal1');
      insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${ator}','${org}','admin',now());
      ${conferir}
      update public.user_organizations set role='manager' where user_id='${ator}' and organization_id='${org}';
      ${conferir}
      rollback;
    `);
    expect(linhas.split("\n").filter((linha) => linha.startsWith("admin:"))).toEqual(["admin:true","admin:false"]);
  });

  it("reconectar um anunciante preserva a outra conta e a outra organização", () => {
    const orgA = "ba000000-9433-4000-8000-000000000001";
    const orgB = "ba000000-9433-4000-8000-000000000002";
    const linhas = sql(`
      begin;
      insert into public.organizations(id, slug, legal_name, display_name)
        values ('${orgA}','anunciante-a','A','A'), ('${orgB}','anunciante-b','B','B');
      set local role service_role;
      insert into public.google_ads_reporting_accounts(organization_id,customer_id,label,refresh_token_encrypted)
        values ('${orgA}','1111111111','A1','a'), ('${orgA}','2222222222','A2','b'),
               ('${orgB}','1111111111','B1','c');
      insert into public.google_ads_reporting_accounts(organization_id,customer_id,label,refresh_token_encrypted)
        values ('${orgA}','1111111111','A1','d')
        on conflict (organization_id,customer_id) do update set refresh_token_encrypted=excluded.refresh_token_encrypted;
      select label || ':' || convert_from(refresh_token_encrypted,'utf8')
        from public.google_ads_reporting_accounts where organization_id in ('${orgA}','${orgB}') order by label;
      rollback;
    `);
    expect(linhas.split("\n").filter((v) => /^[AB][12]:/.test(v))).toEqual(["A1:d", "A2:b", "B1:c"]);
  });
});
