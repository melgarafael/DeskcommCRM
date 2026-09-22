import { execFileSync } from "node:child_process";
import { beforeAll, describe, it, expect } from "vitest";
const container = process.env.TEST_DB_CONTAINER!;
const sql = (query: string) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
    ],
    { input: query, encoding: "utf8" },
  ).trim();
const org = "c0322000-0000-4000-8000-000000000001",
  other = "c0322000-0000-4000-8000-000000000002";
const agent = "c0322000-0000-4000-8000-000000000003",
  viewer = "c0322000-0000-4000-8000-000000000004",
  stranger = "c0322000-0000-4000-8000-000000000005";
const channel = "c0322000-0000-4000-8000-000000000006",
  contact = "c0322000-0000-4000-8000-000000000007",
  conversation = "c0322000-0000-4000-8000-000000000008",
  mission = "c0322000-0000-4000-8000-000000000009";
beforeAll(() => {
  sql(`insert into auth.users(id,email) values('${agent}','voice-agent@test.invalid'),('${viewer}','voice-viewer@test.invalid'),('${stranger}','voice-stranger@test.invalid');
 insert into organizations(id,slug,legal_name,display_name) values('${org}','voice-test-a','Voice A','Voice A'),('${other}','voice-test-b','Voice B','Voice B');
 insert into user_organizations(user_id,organization_id,role,accepted_at) values('${agent}','${org}','agent',now()),('${viewer}','${org}','viewer',now()),('${stranger}','${other}','agent',now());
 insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values('${channel}','${org}','voice-test','\\x00');
 insert into contacts(id,organization_id,name,phone_number) values('${contact}','${org}','Contato sintético','+5511900001111');
 insert into conversations(id,organization_id,contact_id,channel_session_id) values('${conversation}','${org}','${contact}','${channel}');
 insert into voice_missions(id,organization_id,conversation_id,created_by,objective,context_snapshot,result) values('${mission}','${org}','${conversation}','${agent}','Entender a dúvida','histórico sensível','{"summary":"resumo"}');`);
});
const asUser = (id: string, query: string) =>
  sql(
    `set role authenticated;select set_config('request.jwt.claims','{"sub":"${id}"}',false);${query}`,
  )
    .split("\n")
    .at(-1);
describe("voice mission isolation and lifecycle", () => {
  it("agent sees own tenant while viewer and other tenant see nothing", () => {
    expect(asUser(agent, "select count(*) from voice_missions")).toBe("1");
    expect(asUser(viewer, "select count(*) from voice_missions")).toBe("0");
    expect(asUser(stranger, "select count(*) from voice_missions")).toBe("0");
  });
  it("authenticated browser cannot enqueue or mutate runtime heartbeat", () => {
    expect(sql("select has_table_privilege('authenticated','voice_missions','INSERT')")).toBe("f");
    expect(sql("select has_table_privilege('authenticated','voice_missions','UPDATE')")).toBe("f");
    expect(
      sql("select has_table_privilege('authenticated','voice_mission_runtime','UPDATE')"),
    ).toBe("f");
  });
  it("contact anonymization cancels and redacts saved voice context", () => {
    sql(`update contacts set is_anonymized=true,anonymized_at=now() where id='${contact}'`);
    expect(
      sql(
        `select redacted and cancel_requested and objective='' and context_snapshot is null and result is null from voice_missions where id='${mission}'`,
      ),
    ).toBe("t");
  });
});
