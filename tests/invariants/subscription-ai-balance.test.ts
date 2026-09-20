import { randomUUID } from "node:crypto";
import type pg from "pg";
import { expect, it } from "vitest";
import { readAiAllowance } from "../../lib/billing/ai-allowance-view";
import { sql } from "./gov-helpers";
// Execute the production reader against the disposable database, not a SQL mock.
const db = {
  query: async (statement: string, values: string[]) => {
    const org = values[0];
    if (!org || !/^[a-f0-9-]{36}$/.test(org)) throw new Error("Expected synthetic UUID");
    const query = statement.replaceAll("$1", `'${org}'`);
    return { rows: JSON.parse(sql(`select coalesce(json_agg(q),'[]') from (${query}) q`)) };
  },
} as unknown as Pick<pg.Pool, "query">;
function company(paid = true) {
  const org = randomUUID();
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${org}','balance-${org}','Synthetic','Synthetic');`,
  );
  if (paid)
    sql(
      `insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_start,current_period_end) values('${org}','essencial','sub_${org.replaceAll("-", "")}','active',now()-interval '1 day',now()+interval '29 days');`,
    );
  return org;
}
function reserve(org: string) {
  const call = randomUUID();
  sql(`select fn_reserve_subscription_ai('${org}','${call}')`);
  return call;
}
it("reads actual settled and reserved amounts without leaking another company's charges", async () => {
  const org = company();
  const other = company();
  const call = reserve(org);
  sql(`select fn_settle_subscription_ai('${org}','${call}',25)`);
  reserve(org);
  const otherCall = reserve(other);
  sql(`select fn_settle_subscription_ai('${other}','${otherCall}',200)`);
  expect(await readAiAllowance(db, org)).toMatchObject({
    status: "ready",
    budget: 3000,
    used: 150,
    reserved: 100,
    remaining: 2750,
  });
  expect(await readAiAllowance(db, other)).toMatchObject({
    used: 1200,
    reserved: 0,
    remaining: 1800,
  });
});
it("shows the new cycle grant before its first call and excludes old-cycle consumption", async () => {
  const org = company();
  expect(await readAiAllowance(db, org)).toMatchObject({ remaining: 3000, used: 0 });
  const call = reserve(org);
  sql(`select fn_settle_subscription_ai('${org}','${call}',25)`);
  sql(
    `update org_subscriptions set current_period_start=now()-interval '1 hour', current_period_end=now()+interval '30 days' where organization_id='${org}'`,
  );
  expect(await readAiAllowance(db, org)).toMatchObject({ remaining: 3000, used: 0, reserved: 0 });
});
it("retains the reservation and exposes review when cost is unknown", async () => {
  const org = company();
  const call = reserve(org);
  sql(`select fn_settle_subscription_ai('${org}','${call}',null)`);
  expect(await readAiAllowance(db, org)).toMatchObject({
    status: "review",
    remaining: 2900,
    reserved: 100,
  });
});
it("does not present legacy or unconfirmed periods as available credit", async () => {
  expect(await readAiAllowance(db, company(false))).toBeNull();
  const org = company();
  sql(`update org_subscriptions set current_period_start=null where organization_id='${org}'`);
  expect(await readAiAllowance(db, org)).toMatchObject({
    status: "unconfirmed",
    periodStart: null,
  });
});
