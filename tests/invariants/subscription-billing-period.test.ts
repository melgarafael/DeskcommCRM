import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
function company() {
  const org = randomUUID();
  sql(`insert into organizations(id,slug,legal_name,display_name) values('${org}','period-${org}','Synthetic','Synthetic');
    insert into org_subscriptions(organization_id,plan_id,current_period_end) values('${org}','essencial','2026-10-20T17:25:00Z');`);
  return org;
}
it("leaves preexisting paid period starts unknown until provider reconciliation", () => {
  const org = company();
  expect(
    sql(
      `select current_period_start is null from org_subscriptions where organization_id='${org}'`,
    ),
  ).toBe("t");
});
it("preserves the exact provider period on reapplication", () => {
  const org = company();
  sql(
    `update org_subscriptions set current_period_start='2026-09-20T17:25:00Z' where organization_id='${org}'`,
  );
  const before = sql(
    `select current_period_start::text||'/'||current_period_end::text from org_subscriptions where organization_id='${org}'`,
  );
  sql(
    readFileSync("supabase/migrations/20260920075000_0316_subscription_billing_period.sql", "utf8"),
  );
  expect(
    sql(
      `select current_period_start::text||'/'||current_period_end::text from org_subscriptions where organization_id='${org}'`,
    ),
  ).toBe(before);
});
it.each(["'2026-10-20T17:25:00Z'", "'2026-11-01'", "'infinity'", "'-infinity'"])(
  "refuses inconsistent starts %s",
  (value) => {
    const org = company();
    expect(() =>
      sql(
        `update org_subscriptions set current_period_start=${value} where organization_id='${org}'`,
      ),
    ).toThrow(/org_subscriptions_period_order/);
  },
);
it("cannot retain a known start while clearing the end", () => {
  const org = company();
  expect(() =>
    sql(
      `update org_subscriptions set current_period_start='2026-09-20',current_period_end=null where organization_id='${org}'`,
    ),
  ).toThrow(/org_subscriptions_period_order/);
});
