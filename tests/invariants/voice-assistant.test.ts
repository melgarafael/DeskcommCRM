import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { countAs, GOV_ADMIN, seedGov } from "./gov-helpers";
vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: Buffer.alloc(32, 7).toString("base64") } }));
import { performVoiceAction, readVoicePanel } from "@/lib/ai/voice/store";
import type { VoiceSettings } from "@/lib/ai/voice/schema";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const settings: VoiceSettings = {
  voice_id: "voice_12345678",
  language: "pt",
  first_message: "Olá, sou uma assistente de IA.",
  system_prompt: "Entenda primeiro o problema da empresa.",
  max_duration_seconds: 300,
};
let remote: Record<string, unknown> | null;
const providerRequests: { path: string; method: string }[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  providerRequests.push({ path, method: init?.method ?? "GET" });
  if (path === "/v1/voices")
    return Response.json({ voices: [{ voice_id: settings.voice_id, name: "Clara" }] });
  if (path === "/v1/convai/agents")
    return Response.json({ agents: remote ? [remote] : [], has_more: false });
  if (path.endsWith("/create")) {
    remote = { ...JSON.parse(String(init?.body)), agent_id: "agent_12345678" };
    return Response.json({ agent_id: "agent_12345678" });
  }
  if (init?.method === "PATCH") remote = { ...remote, ...JSON.parse(String(init.body)) };
  if (path.endsWith("get-signed-url"))
    return Response.json({ signed_url: "wss://api.elevenlabs.io/private-test" });
  return Response.json(remote);
});
beforeAll(() => seedGov());
beforeEach(() => {
  remote = null;
  providerRequests.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());
async function fixture(member = false) {
  const org = randomUUID(),
    agent = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Voice fixture','Voice fixture')",
    [org, `voice-${org}`],
  );
  if (member)
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())",
      [GOV_ADMIN, org],
    );
  await pool.query(
    `insert into ai_agents(id,organization_id,name,system_prompt,model,kind,paused_at,operation_mode,config)
    values($1,$2,'Clara','Prompt original salvo para a empresa.','openai/gpt-test','mcp_agent',now(),'assisted','{"unrelated_setting":"keep"}')`,
    [agent, org],
  );
  return { org, agent };
}
it("stores an encrypted organization key and never returns it in voice state", async () => {
  const f = await fixture(true);
  const key = "fixture-private-elevenlabs-key";
  await performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, { action: "credential", api_key: key });
  const credential = (
    await pool.query(
      "select api_key_encrypted,api_key_iv,api_key_tag from ai_provider_credentials where organization_id=$1 and provider='elevenlabs'",
      [f.org],
    )
  ).rows[0];
  expect(credential.api_key_encrypted.toString()).not.toContain(key);
  expect(credential.api_key_iv).toHaveLength(12);
  expect(credential.api_key_tag).toHaveLength(16);
  const panel = await readVoicePanel(pool, f.org, f.agent);
  expect(panel.credential_configured).toBe(true);
  expect(panel.settings.system_prompt).toBe("Prompt original salvo para a empresa.");
  expect(JSON.stringify(panel)).not.toContain(key);
  const other = await fixture();
  await performVoiceAction(pool, other.org, GOV_ADMIN, other.agent, {
    action: "credential",
    api_key: "fixture-other-tenant-secret",
  });
  expect(
    countAs(
      GOV_ADMIN,
      `select count(*) from ai_provider_credentials where organization_id='${other.org}'`,
    ),
  ).toBe(0);
});
it("configures and retries one private remote agent while preserving CRM pause, mode, prompt and other config", async () => {
  const f = await fixture();
  await performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, {
    action: "credential",
    api_key: "fixture-private-elevenlabs-key",
  });
  await performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, { action: "configure", settings });
  await performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, { action: "configure", settings });
  const result = (
    await pool.query(
      "select config,paused_at,operation_mode,system_prompt,published_version_id from ai_agents where organization_id=$1 and id=$2",
      [f.org, f.agent],
    )
  ).rows[0];
  expect(result).toMatchObject({
    operation_mode: "assisted",
    published_version_id: null,
    system_prompt: "Prompt original salvo para a empresa.",
    config: {
      unrelated_setting: "keep",
      voice_assistant: { status: "ready", remote_agent_id: "agent_12345678" },
    },
  });
  expect(result.paused_at).not.toBeNull();
  expect(providerRequests.filter((request) => request.path.endsWith("/create"))).toHaveLength(1);
  expect(await performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, { action: "test" })).toEqual({
    signed_url: "wss://api.elevenlabs.io/private-test",
  });
});
it("rejects a foreign agent before credential lookup or provider requests", async () => {
  const own = await fixture(),
    other = await fixture();
  await expect(
    performVoiceAction(pool, own.org, GOV_ADMIN, other.agent, {
      action: "credential",
      api_key: "fixture-must-not-be-stored",
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(readVoicePanel(pool, own.org, other.agent)).rejects.toMatchObject({ status: 404 });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(
        "select count(*)::int as n from ai_provider_credentials where organization_id=$1",
        [own.org],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("refuses a concurrent operation before any remote effect and releases the advisory lock", async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  try {
    await blocker.query("select pg_advisory_lock(hashtextextended($1,0))", [
      `voice-assistant:${f.org}`,
    ]);
    await expect(
      performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, {
        action: "credential",
        api_key: "fixture-must-not-be-stored",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await blocker.query("select pg_advisory_unlock(hashtextextended($1,0))", [
      `voice-assistant:${f.org}`,
    ]);
    blocker.release();
  }
  await performVoiceAction(pool, f.org, GOV_ADMIN, f.agent, {
    action: "credential",
    api_key: "fixture-private-elevenlabs-key",
  });
  expect((await readVoicePanel(pool, f.org, f.agent)).credential_configured).toBe(true);
});
