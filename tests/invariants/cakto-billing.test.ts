import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
it("queue is inaccessible to tenants, writable only by the trusted service", () => {
  for (const role of ["anon", "authenticated"])
    expect(
      sql(
        `select has_table_privilege('${role}','cakto_billing_inbox','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`,
      ),
    ).toBe("f");
  expect(sql("select has_table_privilege('service_role','cakto_billing_inbox','INSERT')")).toBe(
    "t",
  );
});
it("repeated delivery is idempotent and migration can be applied again", () => {
  const statement =
    "insert into cakto_billing_inbox(id,order_id,event_type) values('unit-event','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','purchase_approved') on conflict do nothing;";
  sql(statement + statement);
  expect(sql("select count(*) from cakto_billing_inbox where id='unit-event'")).toBe("1");
  sql(readFileSync("supabase/migrations/20260920150000_0320_cakto_billing.sql", "utf8"));
  expect(sql("select count(*) from cakto_billing_inbox where id='unit-event'")).toBe("1");
});
it("different organizations may share a buyer but cannot share subscription or checkout", () => {
  const a = "aaaaaaaa-0320-4000-8000-000000000001",
    b = "bbbbbbbb-0320-4000-8000-000000000002";
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${a}','cakto-a','A','A'),('${b}','cakto-b','B','B'); insert into org_subscriptions(organization_id,provider,provider_customer_id,provider_subscription_id) values('${a}','cakto','buyer','one'),('${b}','cakto','buyer','two');`,
  );
  expect(() =>
    sql(`update org_subscriptions set provider_subscription_id='one' where organization_id='${b}'`),
  ).toThrow();
  expect(() =>
    sql(
      `update org_subscriptions set checkout_attempt_id=(select checkout_attempt_id from org_subscriptions where organization_id='${a}') where organization_id='${b}'`,
    ),
  ).toThrow();
});
