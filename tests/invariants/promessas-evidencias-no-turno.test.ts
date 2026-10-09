import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { runAgentPreview } from "@/lib/agent-engine/agent/inbound-turn";
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
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  database: "postgres",
  user: "postgres",
  password: "postgres", // Credenciais públicas do Postgres efêmero de teste.
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
      SUPABASE_DB_URL: "postgresql://localhost/postgres",
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
        const value = text.includes("classificador auxiliar de compliance de vendas")
          ? { isPromise: false, suspectPhrase: null }
          : text.includes("Turno interno de memória")
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
  await pool.query(
    "update ai_knowledge_sources set active_kb_version_id=$1 where organization_id=$2 and id=$3",
    [version, f.org, source],
  );
  return { source, version, chunk };
}
it("a guarda da prévia recebe o acervo consultado, mas não o de outra organização", async () => {
  const f = await replyFixture(pool);
  const knowledge = await kb(
    f,
    "Plano anual: matrícula gratuita. Plano mensal: matrícula de R$ 90.",
  );
  const neighbor = await replyFixture(pool);
  await kb(neighbor, "SENTINELA DE OUTRA ORGANIZAÇÃO");
  const agent = (await loadAgentVersionConfig(pool, f.org, f.agent, f.version))!;
  agent.knowledgeSourceIds = [knowledge.source];
  const prompts: string[] = [];
  const d = deps(prompts);
  d.knobs.promiseSemantic = { enabled: true, model: "claude-haiku-4-5" };
  const result = newPreviewResult();
  const preview: TurnPreview = {
    kind: "sandbox",
    organizationId: f.org,
    runId: randomUUID(),
    agent,
    contactId: null,
    channelId: f.channel,
    context: scenarioContext([
      { direction: "inbound", body: "Qual o plano?", sent_at: "2026-09-07T14:00:00Z" },
    ]),
    result,
  };
  await runAgentPreview(d, pool, preview);
  const classifier = prompts.filter((p) =>
    p.includes("classificador auxiliar de compliance de vendas"),
  );
  expect(classifier).toHaveLength(1);
  expect(classifier[0]).toContain("evidencias");
  expect(classifier[0]).toContain("Plano anual: matrícula gratuita");
  expect(classifier[0]).toContain(knowledge.source);
  expect(classifier[0]).not.toContain("SENTINELA DE OUTRA ORGANIZAÇÃO");
  expect(result.candidates).toHaveLength(1);
});
