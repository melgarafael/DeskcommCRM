import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
function setup(scope = "full") {
  const org = randomUUID(),
    call = randomUUID(),
    actor = randomUUID();
  sql(
    "insert into auth.users(id,email) values('" +
      actor +
      "','" +
      actor +
      "@invariant.test');" +
      "insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values('" +
      actor +
      "','" +
      actor +
      "','" +
      scope +
      "',false,'Synthetic test');" +
      "insert into organizations(id,slug,legal_name,display_name) values('" +
      org +
      "','review-" +
      org +
      "','Synthetic','Synthetic');" +
      "insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_start,current_period_end) values('" +
      org +
      "','essencial','sub_" +
      org +
      "','active',now()-interval '1 day',now()+interval '29 days');" +
      "select fn_reserve_subscription_ai('" +
      org +
      "','" +
      call +
      "');" +
      "select fn_record_subscription_ai_evidence('" +
      org +
      "','" +
      call +
      "','openai','test-model',null);" +
      "select fn_settle_subscription_ai('" +
      org +
      "','" +
      call +
      "',null);",
  );
  return { org, call, actor };
}
function reconcile(
  s: ReturnType<typeof setup>,
  cost = "0.25",
  reference = "Provider report resp_test",
) {
  return sql(
    "select fn_reconcile_subscription_ai('" +
      s.org +
      "','" +
      s.call +
      "','" +
      s.actor +
      "'," +
      cost +
      ",'" +
      reference +
      "','test_request')",
  );
}
it("resolves against the original cycle and writes one immutable audit on retries", () => {
  const s = setup();
  expect(Number(reconcile(s))).toBe(1.5);
  expect(Number(reconcile(s))).toBe(1.5);
  expect(
    sql(
      "select count(*) from api_audit_log where action='billing.ai_reconciled' and resource_id='" +
        s.call +
        "'",
    ),
  ).toBe("1");
  expect(
    sql(
      "select actor_user_id::text||'|'||(metadata->>'reference') from api_audit_log where resource_id='" +
        s.call +
        "'",
    ),
  ).toBe(s.actor + "|Provider report resp_test");
  expect(() => reconcile(s, "2")).toThrow();
  expect(() => reconcile(s, "0.25", "Different report")).toThrow();
  expect(sql("select status from subscription_ai_reservations where id='" + s.call + "'")).toBe(
    "settled",
  );
  sql("select fn_reserve_subscription_ai('" + s.org + "','" + randomUUID() + "')");
});
it("refuses readonly and revoked administrators", () => {
  for (const scope of ["support_readonly", "full"]) {
    const s = setup(scope);
    if (scope === "full")
      sql("update platform_admins set revoked_at=now() where user_id='" + s.actor + "'");
    expect(() => reconcile(s)).toThrow();
    expect(sql("select status from subscription_ai_reservations where id='" + s.call + "'")).toBe(
      "unknown",
    );
  }
});
it("never resolves another organization's reservation", () => {
  const a = setup(),
    b = setup();
  expect(() => reconcile({ ...a, org: b.org })).toThrow();
  expect(sql("select status from subscription_ai_reservations where id='" + a.call + "'")).toBe(
    "unknown",
  );
});
it("does not resolve in-flight or unidentified consumption", () => {
  const s = setup();
  sql("update subscription_ai_reservations set status='reserved' where id='" + s.call + "'");
  expect(() => reconcile(s)).toThrow();
  sql(
    "update subscription_ai_reservations set status='unknown',provider=null where id='" +
      s.call +
      "'",
  );
  expect(() => reconcile(s)).toThrow();
});
it("does not move an old consumption into the renewed cycle", () => {
  const s = setup();
  sql(
    "update org_subscriptions set current_period_start=now(),current_period_end=now()+interval '30 days' where organization_id='" +
      s.org +
      "'",
  );
  expect(Number(reconcile(s, "10000"))).toBe(3000);
  sql("select fn_reserve_subscription_ai('" + s.org + "','" + randomUUID() + "')");
  expect(
    sql("select count(*) from subscription_ai_periods where organization_id='" + s.org + "'"),
  ).toBe("2");
});
it("rejects invalid money and never exposes the RPC to tenants", () => {
  const s = setup();
  for (const cost of ["null", "-1", "'NaN'::numeric", "'Infinity'::numeric"])
    expect(() => reconcile(s, cost)).toThrow();
  expect(
    sql(
      "select has_function_privilege('authenticated','fn_reconcile_subscription_ai(uuid,uuid,uuid,numeric,text,text)','execute') or has_function_privilege('anon','fn_reconcile_subscription_ai(uuid,uuid,uuid,numeric,text,text)','execute')",
    ),
  ).toBe("f");
});
it("rolls settlement back when the audit cannot be written", () => {
  const s = setup();
  sql(
    "create function reject_review_test() returns trigger language plpgsql as $$ begin if new.action='billing.ai_reconciled' then raise exception 'synthetic audit failure'; end if; return new; end $$;" +
      "create trigger reject_review_test before insert on api_audit_log for each row execute function reject_review_test();",
  );
  try {
    expect(() => reconcile(s)).toThrow();
    expect(sql("select status from subscription_ai_reservations where id='" + s.call + "'")).toBe(
      "unknown",
    );
  } finally {
    sql("drop trigger reject_review_test on api_audit_log; drop function reject_review_test();");
  }
});
