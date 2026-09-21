import { beforeAll, describe, it, expect } from "vitest";
import { sql, lastLine } from "./gov-helpers";
const a = "a3210000-0000-4000-8000-000000000001",
  b = "b3210000-0000-4000-8000-000000000001",
  u = "a3210000-1111-4000-8000-000000000001";
beforeAll(() => {
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${a}','studio-a','A','A'),('${b}','studio-b','B','B');insert into auth.users(id,email) values('${u}','studio@invariant.test');insert into user_organizations(user_id,organization_id,role,accepted_at) values('${u}','${a}','agent',now());insert into instagram_studio_items(id,organization_id,kind,status,input) values('a3210000-2222-4000-8000-000000000001','${a}','post','generating','{}'),('b3210000-2222-4000-8000-000000000001','${b}','post','generating','{}');`,
  );
});
describe("Instagram database boundaries", () => {
  it("shows only the authenticated user's company", () => {
    expect(
      lastLine(
        sql(
          `set role authenticated;select set_config('request.jwt.claims','{"sub":"${u}"}',false);select count(*) from instagram_studio_items;`,
        ),
      ),
    ).toBe("1");
  });
  it("denies browser mutations even inside the company", () => {
    expect(
      sql(
        "select bool_and(not has_table_privilege('authenticated','instagram_studio_items',p)) from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p",
      ),
    ).toBe("t");
    expect(sql("select has_table_privilege('anon','instagram_studio_items','SELECT')")).toBe("f");
  });
  it("deduplicates a request before an external generation can start", () => {
    expect(() =>
      sql(
        `insert into instagram_studio_items(id,organization_id,kind,status,input) values('a3210000-2222-4000-8000-000000000001','${a}','post','generating','{}')`,
      ),
    ).toThrow();
  });
});
