import { describe, expect, it } from "vitest";
import { sql, motivoDoErro } from "./psql-transporte";

function erro(script: string): string {
  try {
    sql(script);
  } catch (e) {
    return motivoDoErro(e);
  }
  throw new Error("A chamada deveria ser recusada pelo banco");
}
const ORG = "05360000-0000-4000-8000-000000000001";
const USER = "05360000-1111-4000-8000-000000000001";
const seed = `begin;
 insert into auth.users (id,email) values ('${USER}','sem-link@invariant.test') on conflict do nothing;
 insert into public.organizations(id,slug,legal_name,display_name) values ('${ORG}','sem-link-0536','Loja teste','Loja teste') on conflict do nothing;
 insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${USER}','${ORG}','admin',now()) on conflict do nothing;
 set role authenticated;
 select set_config('request.jwt.claims','{"sub":"${USER}"}',false);`;

describe("aviso local — schema e autoridade", () => {
  it("campo não nulo preserva modo público como padrão", () => {
    expect(
      sql(
        "select is_nullable || ':' || column_default from information_schema.columns where table_schema='public' and table_name='config_aviso_de_caso' and column_name='sem_link';",
      ).trim(),
    ).toBe("NO:false");
  });
  it("admin grava e restaura modo público pela porta local", () => {
    const r = sql(
      seed +
        `
   select public.fn_definir_aviso_de_caso_local('${ORG}',null,'+12025550123',null,false,false,true);
   select sem_link from public.config_aviso_de_caso where organization_id='${ORG}';
   select public.fn_definir_aviso_de_caso_local('${ORG}',null,'+12025550123',null,false,false,false);
   select sem_link from public.config_aviso_de_caso where organization_id='${ORG}'; rollback;`,
    );
    expect(r.split("\n").filter((v) => v === "t" || v === "f")).toEqual(["t", "f"]);
  });
  it("admin não escreve configuração do vizinho", () => {
    expect(
      erro(
        seed +
          "select public.fn_definir_aviso_de_caso_local('05360000-0000-4000-8000-000000000002',null,'+12025550123',null,false,false,true);",
      ),
    ).toMatch(/aviso_de_caso_forbidden/);
  });
  it("anon não chama a porta local", () => {
    expect(
      erro(
        "set role anon; select public.fn_definir_aviso_de_caso_local(null,null,null,null,false,false,true);",
      ),
    ).toMatch(/permission denied/);
  });
  it("service role sem identidade humana é recusado", () => {
    expect(
      erro(
        "set role service_role; select public.fn_definir_aviso_de_caso_local(null,null,null,null,false,false,true);",
      ),
    ).toMatch(/aviso_de_caso_forbidden|permission denied/);
  });
});
