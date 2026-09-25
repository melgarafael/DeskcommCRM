/** 0406: isolamento de tenant, autorização, escrita por tema e rollback do cliente antigo. */
import { beforeAll, describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";
const org = "10c00398-0000-4000-8000-000000000001";
const outra = "10c00398-0000-4000-8000-000000000002";
const admin = "10c00398-1111-4000-8000-000000000001";
const estranho = "10c00398-1111-4000-8000-000000000002";
const arquivo = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png";
const path = `${org}/${arquivo}`;
const fn = "public.fn_definir_logo_por_tema_da_organizacao";
const gravar = (o = org, a = admin, p: string | null = path, tema = "escuro") =>
  sql(`select ${fn}('${o}','${a}',${p === null ? "null" : `'${p}'`},'${tema}');`);
const ler = () =>
  JSON.parse(
    lastLine(sql(`select settings->'branding' from public.organizations where id='${org}';`)),
  );
beforeAll(() => {
  sql(`insert into auth.users(id,email) values ('${admin}','logo398a@invariant.test'),('${estranho}','logo398b@invariant.test');
 insert into public.organizations(id,slug,legal_name,display_name) values ('${org}','logo398a','A','A'),('${outra}','logo398b','B','B');
 insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${admin}','${org}','admin',now()),('${estranho}','${outra}','admin',now());`);
});
describe("logo por tema no banco", () => {
  it("grava escuro sem perder claro e salvar nome/cor preserva ambos", () => {
    sql(`select public.fn_definir_logo_da_organizacao('${org}','${admin}','${path}');`);
    gravar();
    sql(
      `select public.fn_definir_marca_da_organizacao('${org}','${admin}','{"app_name":"Nova marca","logo_dark_path":"injetado"}'::jsonb);`,
    );
    expect(ler()).toMatchObject({ logo_path: path, logo_dark_path: path, app_name: "Nova marca" });
    sql(`select public.fn_definir_marca_da_organizacao('${org}','${admin}',null);`);
    expect(ler()).toEqual({ logo_path: path, logo_dark_path: path });
  });
  it("remoção escura mantém padrão", () => {
    gravar();
    gravar(org, admin, null);
    expect(ler().logo_dark_path).toBeUndefined();
    expect(ler().logo_path).toBe(path);
  });
  it("recusa ator de outra organização", () => expect(() => gravar(org, estranho)).toThrow());
  it("recusa caminho de outra organização e da instalação", () => {
    expect(() => gravar(org, admin, `${outra}/${arquivo}`)).toThrow();
    expect(() => gravar(org, admin, `platform/${arquivo}`)).toThrow();
  });
  it("recusa tema desconhecido", () =>
    expect(() => gravar(org, admin, path, "inventado")).toThrow());
  it("não concede execução a anon nem authenticated", () => {
    for (const role of ["anon", "authenticated"])
      expect(
        lastLine(
          sql(`select has_function_privilege('${role}','${fn}(uuid,uuid,text,text)','EXECUTE');`),
        ),
      ).toBe("f");
  });
  it("coluna da instalação recusa caminho de tenant", () => {
    expect(() =>
      sql(
        `insert into public.platform_branding(id,logo_dark_path) values(1,'${path}') on conflict(id) do update set logo_dark_path=excluded.logo_dark_path;`,
      ),
    ).toThrow();
  });
});
