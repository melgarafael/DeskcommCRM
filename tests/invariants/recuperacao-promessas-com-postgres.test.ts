import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { criarRecuperadorDeEvidencias } from "@/lib/agent-engine/guardrails/promise/recuperar-evidencias";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { runAgentPreview } from "@/lib/agent-engine/agent/inbound-turn";
import {
  scenarioContext,
  newPreviewResult,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT),
  database: "postgres",
  user: "postgres",
  password: "postgres",
  max: 4,
});
beforeAll(async () => {
  await seedGov();
  await pool.query(`with v as(insert into playbook_versions(organization_id,layer,content)
    select null,'platform','## Identidade: Assistente sintético.' where not exists
    (select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
});
afterAll(() => pool.end());

async function fonte(f: Awaited<ReturnType<typeof replyFixture>>, content: string, quantity = 1) {
  const source = randomUUID(),
    version =
      (await pool.query("select active_kb_version_id from ai_agents where id=$1", [f.agent]))
        .rows[0].active_kb_version_id ?? randomUUID();
  await pool.query(
    "insert into ai_knowledge_sources(id,organization_id,agent_id,source_type,name,status) values($1,$2,$3,'faq','Oferta sintética '||($1::uuid)::text,'ready')",
    [source, f.org, f.agent],
  );
  await pool.query(
    "insert into ai_knowledge_versions(id,organization_id,agent_id,version_number,is_active) values($1,$2,$3,1,true) on conflict(id) do nothing",
    [version, f.org, f.agent],
  );
  await pool.query(
    `insert into ai_chunks(id,organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding)
    select gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,n,$4,$2::text||n::text,15,array_fill(0.1::real,array[1536])::vector from generate_series(0,$5::integer-1) n`,
    [f.org, source, version, content, quantity],
  );
  await pool.query("update ai_knowledge_sources set active_kb_version_id=$1 where id=$2", [
    version,
    source,
  ]);
  await pool.query("update ai_agents set active_kb_version_id=$1 where id=$2", [version, f.agent]);
  return { source, version };
}

it("a busca real encontra acentos, limita a cinco e exclui fonte alheia, inativa ou versão antiga", async () => {
  const own = await replyFixture(pool),
    other = await replyFixture(pool);
  const content =
    "Matrícula grátis no período anual de demonstração; cadastro antes da confirmação.";
  const a = await fonte(own, content, 8),
    b = await fonte(other, "Matrícula grátis SENTINELA ALHEIA");
  const inactive = await fonte(own, "Matrícula grátis SENTINELA INATIVA");
  await pool.query("update ai_knowledge_sources set is_active=false where id=$1", [
    inactive.source,
  ]);
  const oldVersion = randomUUID();
  await pool.query(
    "insert into ai_knowledge_versions(id,organization_id,agent_id,version_number,is_active) values($1,$2,$3,2,false)",
    [oldVersion, own.org, own.agent],
  );
  await pool.query(
    `insert into ai_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding)
    values($1::uuid,$2::uuid,$3::uuid,0,'Matrícula grátis SENTINELA ANTIGA',$3::text,8,array_fill(0.1::real,array[1536])::vector)`,
    [own.org, a.source, oldVersion],
  );
  const results: Array<{ content: string; knowledge_source_id: string }> = [];
  const recuperar = criarRecuperadorDeEvidencias(pool, {
    tenantId: own.org,
    fontes: [a.source, b.source, inactive.source],
    registrar: (r) => results.push(...(r as { results: typeof results }).results),
    log: createLogger(),
  });
  await recuperar("Temos matrícula grátis no período de demonstração");
  expect(results).toHaveLength(5);
  expect(results.every((r) => r.knowledge_source_id === a.source && r.content === content)).toBe(
    true,
  );
});

it("o índice textual do baseline atende uma busca seletiva num acervo real", async () => {
  const f = await replyFixture(pool);
  const a = await fonte(
    f,
    "Texto sintético comum. " + "Material informativo comum. ".repeat(30),
    5000,
  );
  await pool.query(
    "update ai_chunks set content='Matrícula grátis no período anual' where knowledge_source_id=$1 and position=0",
    [a.source],
  );
  await pool.query("analyze ai_chunks");
  const definition = await pool.query(
    "select indexdef from pg_indexes where schemaname='public' and indexname='ai_chunks_content_pt_gin'",
  );
  expect(definition.rows[0]?.indexdef).toContain("USING gin");
  const plan = await pool.query(`explain (analyze,format json) select id from ai_chunks
    where to_tsvector('portuguese',content) @@ websearch_to_tsquery('portuguese','matrícula')`);
  expect(JSON.stringify(plan.rows)).toContain("ai_chunks_content_pt_gin");
});

it("o turno recupera a oferta antes do revisor mesmo sem chamar search_knowledge", async () => {
  const f = await replyFixture(pool);
  const policy =
    "Matrícula grátis no período anual de demonstração; cadastro antes da confirmação.";
  const kb = await fonte(f, policy);
  const agent = (await loadAgentVersionConfig(pool, f.org, f.agent, f.version))!;
  agent.knowledgeSourceIds = [kb.source];
  const knobs = turnKnobsFromEnv(
    loadEnv({
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://localhost/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    }),
  );
  delete knobs.stageClassifier;
  delete knobs.jailbreak;
  knobs.promiseSemantic = { enabled: true, model: "claude-haiku-4-5" };
  const classifierPrompts: string[] = [];
  const candidate = "Temos matrícula grátis no período anual. Qual período prefere?";
  const registry = createFakeRegistry(async (options) => {
    const text = JSON.stringify(options.prompt);
    const results = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content);
    let content: Array<
      | { type: "text"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
    >;
    if (!options.tools?.length) {
      const isReviewer = text.includes("classificador auxiliar de compliance de vendas");
      if (isReviewer) classifierPrompts.push(text);
      content = [
        {
          type: "text",
          text: JSON.stringify(
            isReviewer
              ? { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: false }
              : {
                  rolling_summary: "Fechamento sintético",
                  commitments: [],
                  objections: [],
                  next_action: null,
                },
          ),
        },
      ];
    } else {
      const sent = results.some((r) => "toolName" in r && r.toolName === "send_message");
      content = sent
        ? [{ type: "text", text: "Concluído." }]
        : [
            {
              type: "tool-call",
              toolCallId: randomUUID(),
              toolName: "send_message",
              input: JSON.stringify({ body: candidate }),
            },
          ];
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
  });
  const result = newPreviewResult();
  const preview: TurnPreview = {
    kind: "sandbox",
    organizationId: f.org,
    runId: randomUUID(),
    agent,
    contactId: null,
    channelId: f.channel,
    context: scenarioContext([
      {
        direction: "inbound",
        body: "Quero conhecer a oferta anual.",
        sent_at: "2026-09-07T14:00:00Z",
      },
    ]),
    result,
  };
  await runAgentPreview(
    {
      crmCfg: { supabase: createClient("http://127.0.0.1:1", "test-key") },
      llmCfg: { anthropicApiKey: "fake-local" },
      knobs,
      log: createLogger(),
      clock: () => new Date("2026-09-07T15:00:00Z"),
      registry,
      embed: async () => ({
        embedding: Array(1536).fill(0.1),
        promptTokens: 0,
        model: "text-embedding-3-small",
      }),
    },
    pool,
    preview,
  );
  expect(classifierPrompts).toHaveLength(1);
  expect(classifierPrompts[0]).toContain(policy);
  expect(classifierPrompts[0]).toContain(kb.source);
  expect(result.candidates).toHaveLength(1);
});
