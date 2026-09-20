import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { sql, countAs } from "./gov-helpers";
const A = "aaaaaaaa-0265-4000-8000-000000000001";
const B = "bbbbbbbb-0265-4000-8000-000000000002";
const UA = "aaaaaaaa-0265-4000-8000-000000000003";
const UB = "bbbbbbbb-0265-4000-8000-000000000004";
beforeAll(() => {
  sql(
    [
      [A, UA, "a"],
      [B, UB, "b"],
    ]
      .map(
        ([org, user, tag]) => `
    insert into auth.users(id,email) values('${user}','billing-${tag}@invariant.test');
    insert into organizations(id,slug,legal_name,display_name) values('${org}','billing-${tag}','Billing ${tag}','Billing ${tag}');
    insert into user_organizations(user_id,organization_id,role,accepted_at) values('${user}','${org}','admin',now());
    insert into org_subscriptions(organization_id,plan_id,status) values('${org}','essencial','active');
  `,
      )
      .join("\n"),
  );
});
it("admin sees own subscription but no other tenant", () => {
  expect(countAs(UA, "select count(*) from org_subscriptions")).toBe(1);
  expect(countAs(UA, `select count(*) from org_subscriptions where organization_id='${B}'`)).toBe(
    0,
  );
  expect(countAs(UB, `select count(*) from org_subscriptions where organization_id='${B}'`)).toBe(
    1,
  );
});
it("tenant cannot grant itself a plan or write payment events", () => {
  for (const table of ["org_subscriptions", "billing_webhook_events"]) {
    expect(
      sql(`select has_table_privilege('authenticated','public.${table}','INSERT,UPDATE,DELETE')`),
    ).toBe("f");
  }
});
it("manager cannot read billing", () => {
  sql(`update user_organizations set role='manager' where user_id='${UB}'`);
  expect(countAs(UB, "select count(*) from org_subscriptions")).toBe(0);
  sql(`update user_organizations set role='admin' where user_id='${UB}'`);
});
it("migration is idempotent and preserves existing subscriptions", () => {
  sql(readFileSync("supabase/migrations/20260920010000_0265_org_subscriptions.sql", "utf8"));
  expect(sql(`select status from org_subscriptions where organization_id='${A}'`)).toBe("active");
});
