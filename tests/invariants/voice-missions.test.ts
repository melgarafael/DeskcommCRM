import pg from "pg";
import { saveMission, missionConfiguration, missionContext } from "../../lib/voice/missions/store";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => pool.end());
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
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
  it("enqueues and resolves voice configuration in an organization without AI agents", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic");
    vi.stubEnv("WACALLS_API_BASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("WACALLS_API_TOKEN", "synthetic");
    const input = {
      id: "c0322000-0000-4000-8000-000000000010",
      action: "start" as const,
      objective: "Esclarecer a proposta com o contato",
      agent_id: null,
      channel_id: channel,
      test: false,
      test_contact_id: null,
    };
    try {
      sql(`update channel_sessions set provider='wacalls',status='WORKING',wacalls_session_id='synthetic',wacalls_paired_at=now() where id='${channel}';
      insert into org_voice_calls(organization_id,enabled) values('${org}',true);
      insert into voice_mission_runtime(id,heartbeat_at) values(1,now()) on conflict(id) do update set heartbeat_at=now();`);
      expect(sql(`select count(*) from ai_agents where organization_id='${org}'`)).toBe("0");
      await saveMission(pool, org, agent, conversation, input);
      await saveMission(pool, org, agent, conversation, input);
      expect(
        sql(
          `select status||':'||(agent_id is null)::text from voice_missions where id='${input.id}'`,
        ),
      ).toBe("queued:true");
      sql(`update auth.users set raw_user_meta_data='{"full_name":"Felipe"}' where id='${agent}'`);
      expect(JSON.parse(await missionContext(pool, org, conversation, agent)).solicitante).toBe(
        "Felipe",
      );
      expect(JSON.parse(await missionContext(pool, org, conversation, stranger)).solicitante).toBe(
        "",
      );
      const m = {
        organization_id: org,
        conversation_id: conversation,
        ...input,
        channel_id: channel,
      };
      expect(await missionConfiguration(pool, m)).toMatchObject({
        system_prompt: null,
        wacalls_session_id: "synthetic",
      });
      expect(await missionConfiguration(pool, { ...m, organization_id: other })).toBeUndefined();
      expect(await missionConfiguration(pool, { ...m, agent_id: stranger })).toBeUndefined();
      await expect(
        saveMission(pool, org, agent, conversation, {
          ...input,
          id: "c0322000-0000-4000-8000-000000000011",
          agent_id: stranger,
        }),
      ).rejects.toThrow("Uma das escolhas");
      sql(`update contacts set is_blocked=true where id='${contact}'`);
      expect(await missionConfiguration(pool, m)).toBeUndefined();
      sql(`update contacts set is_blocked=false where id='${contact}'`);
      sql(`update channel_sessions set wacalls_paired_at=null where id='${channel}'`);
      expect(await missionConfiguration(pool, m)).toBeUndefined();
    } finally {
      sql(`delete from voice_missions where id='${input.id}'`);
      vi.unstubAllEnvs();
    }
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
