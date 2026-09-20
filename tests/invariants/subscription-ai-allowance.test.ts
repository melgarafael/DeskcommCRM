import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
const exec = promisify(execFile);
function company(paid = true) {
  const org = randomUUID();
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${org}','credit-${org}','Synthetic','Synthetic');`,
  );
  if (paid)
    sql(`insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_start,current_period_end)
    values('${org}','essencial','sub_${org.replaceAll("-", "")}','active',now()-interval '1 day',now()+interval '29 days');`);
  return org;
}
function reserve(org: string, call = randomUUID()) {
  sql(`select fn_reserve_subscription_ai('${org}','${call}')`);
  return call;
}
function settle(org: string, call: string, cost: number | null) {
  return Number(sql(`select fn_settle_subscription_ai('${org}','${call}',${cost ?? "null"})`));
}
it("does not convert legacy companies", () => {
  const org = company(false);
  expect(sql(`select fn_reserve_subscription_ai('${org}','${randomUUID()}') is null`)).toBe("t");
  expect(sql(`select count(*) from subscription_ai_periods where organization_id='${org}'`)).toBe(
    "0",
  );
});
it("reserves BRL then settles fractional USD using the period tariff, idempotently", () => {
  const org = company();
  const call = reserve(org);
  expect(
    sql(`select reserved_brl_cents from subscription_ai_reservations where id='${call}'`),
  ).toBe("100");
  expect(settle(org, call, 0.25)).toBe(1.5);
  expect(settle(org, call, 0.25)).toBe(1.5);
  expect(() => settle(org, call, 1)).toThrow(/outro valor/);
  expect(
    sql(
      `select sum(charged_brl_cents) from subscription_ai_reservations where organization_id='${org}'`,
    ),
  ).toBe("1.50");
});
it("protects other in-flight reservations and never charges above the granted credit", () => {
  const org = company();
  const a = reserve(org);
  const b = reserve(org);
  expect(settle(org, a, 100000)).toBe(2900);
  expect(() => reserve(org)).toThrow(/esgotada/);
  expect(settle(org, b, 100000)).toBe(100);
  expect(
    sql(
      `select sum(charged_brl_cents) from subscription_ai_reservations where organization_id='${org}'`,
    ),
  ).toBe("3000");
  expect(() => reserve(org)).toThrow(/esgotada/);
});
it("unknown costs retain their reservation and block new work until reconciled", () => {
  const org = company();
  const call = reserve(org);
  expect(sql(`select fn_settle_subscription_ai('${org}','${call}',null) is null`)).toBe("t");
  expect(() => reserve(org)).toThrow(/precisa ser conferido/);
  settle(org, call, 1);
  reserve(org);
});
it("settles the old period after renewal without consuming the new grant", () => {
  const org = company();
  const call = reserve(org);
  const original = sql(`select period_id from subscription_ai_reservations where id='${call}'`);
  sql(
    `update org_subscriptions set current_period_start=now()-interval '1 hour',current_period_end=now()+interval '30 days' where organization_id='${org}'`,
  );
  const next = reserve(org);
  expect(sql(`select period_id from subscription_ai_reservations where id='${next}'`)).not.toBe(
    original,
  );
  expect(settle(org, call, 2)).toBe(12);
  expect(
    sql(
      `select coalesce(sum(charged_brl_cents),0) from subscription_ai_reservations where organization_id='${org}' and period_id=(select period_id from subscription_ai_reservations where id='${next}')`,
    ),
  ).toBe("0");
});
it.each(["pending", "canceled", "past_due"])(
  "refuses new work for %s but permits final settlement",
  (status) => {
    const org = company();
    const call = reserve(org);
    sql(`update org_subscriptions set status='${status}' where organization_id='${org}'`);
    expect(() => reserve(org)).toThrow(/confirmação/);
    expect(settle(org, call, 0)).toBe(0);
  },
);
it("cannot settle another company's reservation", () => {
  const org = company();
  const other = company();
  const call = reserve(org);
  expect(() => settle(other, call, 0)).toThrow(/não encontrada/);
  expect(sql(`select status from subscription_ai_reservations where id='${call}'`)).toBe(
    "reserved",
  );
});
it("keeps the same period grant and conversion after catalogue changes", () => {
  const org = company();
  const call = reserve(org);
  sql(
    `update subscription_plan_limits set ai_credit_cents=1234,ai_usd_to_brl_rate=99 where plan_id='essencial'`,
  );
  try {
    reserve(org);
    expect(settle(org, call, 1)).toBe(6);
    expect(
      sql(`select budget_brl_cents from subscription_ai_periods where organization_id='${org}'`),
    ).toBe("3000");
  } finally {
    sql(
      `update subscription_plan_limits set ai_credit_cents=3000,ai_usd_to_brl_rate=6 where plan_id='essencial'`,
    );
  }
});
it("serializes simultaneous reservations for the final credit", async () => {
  const org = company();
  const first = reserve(org);
  settle(org, first, 490);
  const run = () =>
    exec("docker", [
      "exec",
      "-i",
      process.env.TEST_DB_CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-c",
      `select fn_reserve_subscription_ai('${org}','${randomUUID()}')`,
    ]);
  const results = await Promise.allSettled([run(), run()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    sql(
      `select sum(reserved_brl_cents) from subscription_ai_reservations where organization_id='${org}' and status='reserved'`,
    ),
  ).toBe("60");
});
it("tenant roles cannot write balances or invoke service-only accounting", () => {
  for (const role of ["anon", "authenticated"]) {
    expect(
      sql(
        `select has_function_privilege('${role}','fn_reserve_subscription_ai(uuid,uuid)','execute')`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select has_function_privilege('${role}','fn_settle_subscription_ai(uuid,uuid,numeric)','execute')`,
      ),
    ).toBe("f");
    expect(
      sql(`select has_table_privilege('${role}','subscription_ai_periods','insert,update,delete')`),
    ).toBe("f");
    expect(
      sql(
        `select has_table_privilege('${role}','subscription_ai_reservations','insert,update,delete')`,
      ),
    ).toBe("f");
  }
});
it.each([-1, "NaN", "Infinity"])("rejects invalid costs %s", (cost) => {
  const org = company();
  const call = reserve(org);
  expect(() =>
    sql(`select fn_settle_subscription_ai('${org}','${call}','${cost}'::numeric)`),
  ).toThrow(/Custo inválido/);
});
