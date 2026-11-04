import { beforeAll, describe, expect, it } from "vitest";
import { countAs, lastLine, sql } from "./gov-helpers";
const O = "90240000-0000-4000-8000-000000000001",
  X = "90240000-0000-4000-8000-000000000002";
const A = "90240000-1111-4000-8000-000000000001",
  B = "90240000-1111-4000-8000-000000000002",
  M = "90240000-1111-4000-8000-000000000003";
const P = "90240000-2222-4000-8000-000000000001",
  S = "90240000-3333-4000-8000-000000000001",
  L = "90240000-4444-4000-8000-000000000001";
beforeAll(() => {
  sql(`
insert into auth.users(id,email)values('${A}','9024-a@invariant.test'),('${B}','9024-b@invariant.test'),('${M}','9024-m@invariant.test');
insert into organizations(id,slug,legal_name,display_name,settings)values('${O}','9024','Synthetic','Synthetic','{"visibility_mode":"own"}'),('${X}','9024-x','Synthetic X','Synthetic X','{}');
insert into user_organizations(organization_id,user_id,role,accepted_at)values('${O}','${A}','agent',now()),('${O}','${B}','agent',now()),('${O}','${M}','manager',now());
insert into organization_data_boundaries(organization_id)values('${O}');
insert into crm_pipelines(id,organization_id,name,slug)values('${P}','${O}','P','p-test');
insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)values('${S}','${O}','${P}','S','s-test',1);
insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,owner_user_id,commercial_owner_user_id,owner_kind,source)values('${L}','${O}','${P}','${S}','Private commercial B','${A}','${B}','user','manual');
`);
});
describe("9024 — RETURNING sem perder precedência comercial", () => {
  it("executor A continua sem ver negócio comercial de B", () => {
    expect(countAs(A, `select count(*) from crm_leads where id='${L}'`)).toBe(0);
  });
  it("B comercial e gestor mantêm leitura", () => {
    for (const u of [B, M])
      expect(countAs(u, `select count(*) from crm_leads where id='${L}'`)).toBe(1);
  });
  it("campos da linha e helper canônico concordam para linha existente", () => {
    for (const u of [A, B, M])
      expect(
        lastLine(
          sql(
            `set role authenticated;select set_config('request.jwt.claims','{"sub":"${u}"}',false);select public.fn_acl_lead('${O}','${L}')=public.fn_acl_lead_row('${O}','${L}','${A}','${B}','${P}');`,
          ),
        ),
      ).toBe("t");
  });
  it("atendente cria negócio próprio privado com INSERT RETURNING", () => {
    expect(
      countAs(
        A,
        `with novo as(insert into crm_leads(organization_id,pipeline_id,stage_id,title,owner_user_id,owner_kind,source)values('${O}','${P}','${S}','Own new','${A}','user','manual')returning id)select count(*) from novo;`,
      ),
    ).toBe(1);
  });
  it("helper não aceita outro tenant informado pelo cliente", () => {
    expect(
      lastLine(
        sql(
          `set role authenticated;select set_config('request.jwt.claims','{"sub":"${A}"}',false);select coalesce(public.fn_acl_lead_row('${X}','${L}','${A}',null,'${P}'),false);`,
        ),
      ),
    ).toBe("f");
  });
});
