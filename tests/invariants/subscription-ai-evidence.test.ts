import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
function setup() {
  const org = randomUUID(),
    call = randomUUID();
  sql(
    "insert into organizations(id,slug,legal_name,display_name) values('" +
      org +
      "','evidence-" +
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
      "');",
  );
  return { org, call };
}
function attach(org: string, call: string, evidence = "null", provider = "openai") {
  return sql(
    "select fn_record_subscription_ai_evidence('" +
      org +
      "','" +
      call +
      "','" +
      provider +
      "','test-model'," +
      evidence +
      ");",
  );
}
const evidence =
  "'" +
  JSON.stringify({ version: 1, steps: [{ responseId: "resp_test", inputTokens: null }] }) +
  "'::jsonb";
it("attaches identity and evidence once without changing the balance", () => {
  const { org, call } = setup();
  attach(org, call);
  attach(org, call, evidence);
  attach(org, call, evidence);
  attach(org, call);
  expect(
    sql(
      "select provider||'|'||model||'|'||status||'|'||reserved_brl_cents from subscription_ai_reservations where id='" +
        call +
        "'",
    ),
  ).toBe("openai|test-model|reserved|100");
  expect(
    sql(
      "select usage_evidence->'steps'->0->>'responseId' from subscription_ai_reservations where id='" +
        call +
        "'",
    ),
  ).toBe("resp_test");
  expect(() => attach(org, call, evidence, "anthropic")).toThrow();
  expect(() =>
    attach(org, call, "'" + JSON.stringify({ version: 1, steps: [] }) + "'::jsonb"),
  ).toThrow();
});
it("rejects another organization without changing its reservation", () => {
  const a = setup(),
    b = setup();
  expect(() => attach(b.org, a.call, evidence)).toThrow();
  expect(
    sql(
      "select provider is null and usage_evidence is null from subscription_ai_reservations where id='" +
        a.call +
        "'",
    ),
  ).toBe("t");
});
it("keeps evidence writes unavailable to tenant and anonymous roles", () => {
  expect(
    sql(
      "select has_function_privilege('anon','fn_record_subscription_ai_evidence(uuid,uuid,text,text,jsonb)','execute') or has_function_privilege('authenticated','fn_record_subscription_ai_evidence(uuid,uuid,text,text,jsonb)','execute')",
    ),
  ).toBe("f");
  expect(
    sql(
      "select has_function_privilege('service_role','fn_record_subscription_ai_evidence(uuid,uuid,text,text,jsonb)','execute')",
    ),
  ).toBe("t");
});
it("rejects malformed evidence", () => {
  const { org, call } = setup();
  for (const invalid of [
    "'null'::jsonb",
    "'{}'::jsonb",
    "'" + JSON.stringify({ version: 1, steps: null }) + "'::jsonb",
  ])
    expect(() => attach(org, call, invalid)).toThrow();
});
