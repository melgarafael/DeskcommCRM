import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { runAgentPreview } from "@/lib/agent-engine/agent/inbound-turn";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import {
  scenarioContext,
  newPreviewResult,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
beforeAll(async () => {
  await seedGov();
  await pool.query(
    `with v as(insert into playbook_versions(organization_id,layer,content) select null,'platform','## Identidade: Assistente de teste.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id) insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`,
  );
});
afterAll(() => pool.end());
function deps(prompts: string[]) {
  const knobs = turnKnobsFromEnv(
    loadEnv({
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    }),
  );
  delete knobs.stageClassifier;
  delete knobs.jailbreak;
  delete knobs.promiseSemantic;
  knobs.compaction = { triggerMessages: 3, transcriptMaxTokens: 2000 };
  return {
    crmCfg: { supabase: createClient("http://127.0.0.1:1", "test-key") },
    llmCfg: { anthropicApiKey: "fake-local" },
    knobs,
    log: createLogger(),
    clock: () => new Date("2026-09-07T15:00:00Z"),
    embed: async () => ({
      embedding: Array(1536).fill(0.1),
      promptTokens: 0,
      model: "text-embedding-3-small",
    }),
    registry: createFakeRegistry(async (options) => {
      const text = JSON.stringify(options.prompt);
      prompts.push(text);
      const results = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content),
        saw = (n: string) => results.some((r) => "toolName" in r && r.toolName === n);
      let content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
      >;
      if (!options.tools?.length) {
        const value = text.includes("Turno interno de memória")
          ? {
              notes: [
                { headline: "Preferência preservada", body: "Cliente prefere informação curta." },
              ],
            }
          : text.includes("Compacte a conversa")
            ? {
                rolling_summary: "Resumo do cenário",
                commitments: [],
                objections: [],
                personal_data: [],
                stage: null,
              }
            : {
                rolling_summary: "Fechamento do cenário",
                commitments: [],
                objections: [],
                next_action: null,
              };
        content = [{ type: "text", text: JSON.stringify(value) }];
      } else {
        const has = (n: string) =>
          options.tools?.some((t) => t.type === "function" && t.name === n);
        const name =
          has("save_lead_note") && !saw("save_lead_note")
            ? "save_lead_note"
            : has("search_knowledge") && !saw("search_knowledge")
              ? "search_knowledge"
              : !saw("send_message")
                ? "send_message"
                : null;
        content = name
          ? [
              {
                type: "tool-call",
                toolCallId: randomUUID(),
                toolName: name,
                input: JSON.stringify(
                  name === "save_lead_note"
                    ? { headline: "Não persistir", body: "Memória privada do cenário" }
                    : name === "search_knowledge"
                      ? { query: "horário" }
                      : { body: "O atendimento começa às nove horas." },
                ),
              },
            ]
          : [{ type: "text", text: "Concluído." }];
      }
      return {
        content,
        finishReason: {
          unified: content[0]?.type === "tool-call" ? "tool-calls" : "stop",
          raw: undefined,
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    }),
  };
}
async function kb(
  f: Awaited<ReturnType<typeof replyFixture>>,
  content = "O atendimento começa às nove horas.",
) {
  const source = randomUUID(),
    version = randomUUID(),
    chunk = randomUUID();
  await pool.query(
    "insert into ai_knowledge_sources(id,organization_id,agent_id,source_type,name,status) values($1,$2,$3,'faq','Horários','ready')",
    [source, f.org, f.agent],
  );
  await pool.query(
    "insert into ai_knowledge_versions(id,organization_id,agent_id,version_number,is_active) values($1,$2,$3,1,true)",
    [version, f.org, f.agent],
  );
  await pool.query(
    "insert into ai_chunks(id,organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,metadata) values($1::uuid,$2,$3,$4,0,$5,$1::text,12,array_fill(0.1::real,array[1536])::vector,'{}')",
    [chunk, f.org, source, version, content],
  );
  await pool.query("update ai_agents set active_kb_version_id=$1 where id=$2", [version, f.agent]);
  return { source, version, chunk };
}
async function clientState(org: string) {
  return (
    await pool.query(
      `select jsonb_build_object('messages',(select count(*) from messages where organization_id=$1),'jobs',(select count(*) from job_queue where organization_id=$1),'notes',(select count(*) from lead_notes where organization_id=$1),'checkpoints',(select count(*) from lead_checkpoints where organization_id=$1),'ledger',(select count(*) from send_ledger where organization_id=$1),'contacts',(select jsonb_agg(to_jsonb(c)) from contacts c where organization_id=$1),'conversations',(select jsonb_agg(to_jsonb(c)) from conversations c where organization_id=$1)) as state`,
      [org],
    )
  ).rows[0].state;
}
it("sandbox percorre flush, compaction, RAG, loop e fechamento com zero mutação operacional/HTTP", async () => {
  const f = await replyFixture(pool),
    knowledge = await kb(f),
    neighbor = await replyFixture(pool);
  await kb(neighbor, "SENTINELA VIZINHA NÃO PODE APARECER");
  const agent = (await loadAgentVersionConfig(pool, f.org, f.agent, f.version))!,
    prompts: string[] = [],
    d = deps(prompts),
    result = newPreviewResult();
  const preview: TurnPreview = {
    kind: "sandbox",
    organizationId: f.org,
    runId: randomUUID(),
    agent,
    contactId: null,
    channelId: f.channel,
    context: scenarioContext(
      Array.from({ length: 4 }, (_, i) => ({
        direction: "inbound",
        body: `Qual o horário? ${i}`,
        sent_at: "2026-09-07T14:00:00Z",
      })),
    ),
    result,
  };
  const before = await clientState(f.org),
    fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("preview_network_forbidden"));
  try {
    await runAgentPreview(d, pool, preview);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
  expect(await clientState(f.org)).toEqual(before);
  expect(result.candidates).toHaveLength(1);
  expect(result.proposals.some((p) => p.tool === "save_lead_note")).toBe(true);
  expect(JSON.stringify(result.candidates)).toContain(knowledge.chunk);
  expect(JSON.stringify(prompts)).not.toContain("SENTINELA VIZINHA");
  expect(prompts.some((p) => p.includes("Turno interno de memória"))).toBe(true);
  expect(prompts.some((p) => p.includes("Compacte a conversa"))).toBe(true);
  expect(preview.notes).toHaveLength(1);
  expect(result.checkpoint).toMatchObject({ rolling_summary: "Fechamento do cenário" });
  expect(
    (
      await pool.query("select distinct job_id from knowledge_searches where organization_id=$1", [
        f.org,
      ])
    ).rows,
  ).toEqual([{ job_id: null }]);
});
it("assistência sob demanda instala fronteira original antes de ler checkpoint", async () => {
  const f = await replyFixture(pool);
  await kb(f);
  const prompts: string[] = [],
    d = deps(prompts);
  delete d.knobs.compaction;
  const oldBoundary = f.boundary;
  await pool.query("select fn_service_status($1,$2,'closed')", [f.org, f.conversation]);
  f.boundary = (await pool.query("select fn_service_begin($1,$2) b", [f.org, f.contact])).rows[0].b;
  await pool.query(
    "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at) values($1,$2,$3,$4,'inbound','text','received','Qual o horário?','2026-09-07T14:00:00Z')",
    [f.org, f.contact, f.conversation, f.channel],
  );
  f.boundary = (await pool.query("select fn_service_begin($1,$2) b", [f.org, f.contact])).rows[0].b;
  await pool.query(
    "insert into lead_checkpoints(organization_id,contact_id,seq,rolling_summary,conversation_id,service_revision,demanda_id,demanda_revision) overriding system value values($1,$2,100,'SENTINELA DE ATENDIMENTO ANTERIOR',$3,$4,$5,$6)",
    [
      f.org,
      f.contact,
      f.conversation,
      oldBoundary.service_revision,
      oldBoundary.demanda_id,
      oldBoundary.demanda_revision,
    ],
  );
  await pool.query(
    "insert into lead_checkpoints(organization_id,contact_id,seq,rolling_summary,conversation_id,service_revision,demanda_id,demanda_revision) overriding system value values($1,$2,1,'RESUMO DO ATENDIMENTO ATUAL',$3,$4,$5,$6)",
    [
      f.org,
      f.contact,
      f.conversation,
      f.boundary.service_revision,
      f.boundary.demanda_id,
      f.boundary.demanda_revision,
    ],
  );

  await generateReplyDraft(pool, d, {
    organizationId: f.org,
    conversationId: f.conversation,
    contactId: f.contact,
    channelId: f.channel,
  });
  expect(JSON.stringify(prompts)).toContain("RESUMO DO ATENDIMENTO ATUAL");
  expect(JSON.stringify(prompts)).not.toContain("SENTINELA DE ATENDIMENTO ANTERIOR");
});
