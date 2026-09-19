import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";
const a = "10000000-0000-4000-8000-000000000011",
  b = "10000000-0000-4000-8000-000000000012";
const campaignA = "20000000-0000-4000-8000-000000000011",
  campaignB = "20000000-0000-4000-8000-000000000012";
beforeAll(() =>
  sql(`insert into organizations(id,slug,legal_name,display_name) values ('${a}','prospect-a','A','A'),('${b}','prospect-b','B','B');
insert into prospecting_campaigns(id,organization_id,request_id,name,search) values ('${campaignA}','${a}',gen_random_uuid(),'A','{}'),('${campaignB}','${b}',gen_random_uuid(),'B','{}');`),
);
describe("prospecting tenant boundary and durable deduplication", () => {
  it("denies every browser role direct access to credentials and campaign commands", () => {
    expect(
      sql(
        "select count(*) from pg_class where oid in ('public.prospecting_settings'::regclass,'public.prospecting_campaigns'::regclass,'public.prospecting_candidates'::regclass) and relrowsecurity",
      ),
    ).toBe("3");
    expect(
      sql(
        `select bool_and(not has_table_privilege(r,t,o)) from unnest(array['anon','authenticated']) r cross join unnest(array['public.prospecting_settings','public.prospecting_campaigns','public.prospecting_candidates']) t cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) o`,
      ),
    ).toBe("t");
  });
  it("rejects linking a candidate to another organization campaign", () => {
    expect(() =>
      sql(
        `insert into prospecting_candidates(organization_id,campaign_id,place_id,data) values ('${a}','${campaignB}','foreign','{}')`,
      ),
    ).toThrow();
  });
  it("deduplicates place and phone within a tenant, while separating tenants", () => {
    sql(
      `insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data) values ('${a}','${campaignA}','same','+5511999990000','{}'),('${b}','${campaignB}','same','+5511999990000','{}')`,
    );
    expect(() =>
      sql(
        `insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data) values ('${a}','${campaignA}','different','+5511999990000','{}')`,
      ),
    ).toThrow();
    expect(() =>
      sql(
        `insert into prospecting_candidates(organization_id,campaign_id,place_id,data) values ('${a}','${campaignA}','same','{}')`,
      ),
    ).toThrow();
    expect(sql("select count(*) from prospecting_candidates")).toBe("2");
  });
  it("allows only one running campaign per tenant, including concurrent commands", () => {
    sql(
      `update prospecting_campaigns set status='running' where id in ('${campaignA}','${campaignB}')`,
    );
    expect(() =>
      sql(
        `insert into prospecting_campaigns(organization_id,request_id,name,search,status) values ('${a}',gen_random_uuid(),'duplicate','{}','running')`,
      ),
    ).toThrow();
  });
});

describe("prospecting contact erasure", () => {
  it("redacts discovery data, stops outreach, isolates tenants and refuses re-import", () => {
    const contact = "30000000-0000-4000-8000-000000000011";
    sql(`insert into contacts(id,organization_id,name,phone_number) values ('${contact}','${a}','Pessoa Teste','+5511988880000');
      insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data,status,contact_id,error)
      values ('${a}','${campaignA}','erase-place','+5511988880000','{"name":"Pessoa Teste","emails":["pessoa@example.test"],"address":"Rua Teste"}','queued','${contact}','Pessoa Teste');
      select fn_lgpd_cascade_redact_contact('${a}','${contact}',gen_random_uuid());`);
    const erased = JSON.parse(
      sql(
        `select json_build_object('phone',phone,'data',data,'status',status,'error',error,'place_id',place_id,'salt_bytes',octet_length(suppression_salt)) from prospecting_candidates where contact_id='${contact}' and organization_id='${a}'`,
      ),
    );
    expect(erased).toMatchObject({
      phone: null,
      status: "skipped",
      error: null,
      salt_bytes: 32,
      data: { emails: [], socials: [], address: null, phone: null },
    });
    expect(erased.place_id).toMatch(/^redacted:/);
    expect(JSON.stringify(erased)).not.toMatch(
      /Pessoa Teste|pessoa@example|Rua Teste|5511988880000/,
    );
    expect(
      sql(
        `select fn_lgpd_cascade_redact_contact('${a}','${contact}',gen_random_uuid())->>'already_anonymized'`,
      ),
    ).toBe("true");
    sql(`insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data) values
      ('${a}','${campaignA}','erase-place','+5511977770000','{}'),
      ('${a}','${campaignA}','different-erase-place','+5511988880000','{}'),
      ('${b}','${campaignB}','erase-place','+5511988880000','{}');`);
    expect(
      sql(
        `select count(*) from prospecting_candidates where organization_id='${a}' and (place_id in ('erase-place','different-erase-place') or phone='+5511988880000')`,
      ),
    ).toBe("0");
    expect(
      sql(
        `select count(*) from prospecting_candidates where organization_id='${b}' and place_id='erase-place' and phone='+5511988880000'`,
      ),
    ).toBe("1");
    expect(
      sql(
        `select data->>'name' from prospecting_candidates where organization_id='${a}' and contact_id='${contact}'`,
      ),
    ).toMatch(/^Cliente Anonimizado/);
  });
});
