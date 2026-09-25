/**
 * RASCUNHO ASSISTIDO: ENVIO VETADO NÃO ENCERRA O TURNO.
 *
 * O #1605 fez a prévia assistida parar o loop do modelo no `send_message`, para
 * não gastar a etapa que só "encerrava". A primeira versão parava por
 * `hasToolCall('send_message')`, que no `ai` 7 olha se o último passo CHAMOU a
 * tool, não o resultado. Na prévia, um envio vetado pela cadeia before_send
 * volta ao modelo como `{ ok: false }`, sem candidato (`preview.ts`), e o turno
 * real trata esse 1º veto como ensino: o modelo reescreve. Parando ali, o
 * rascunho saía vazio (status `failed`).
 *
 * Aqui o 1º envio vaza `crm_list_leads` (veto `internal_vocabulary_leak`) e o 2º
 * é válido: o rascunho tem de sair `pending` com o 2º corpo. Com a parada por
 * "chamou send_message" este caso sai `failed` e com corpo vazio.
 *
 * Arquivo próprio, e não mais um caso em `autonomia-preview-core.test.ts`, porque
 * `tests/invariants/**` é congelado para edição (loop/hooks/freeze-invariants.sh).
 */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
beforeAll(async () => {
  await seedGov();
  await pool.query(
    `with v as(insert into playbook_versions(organization_id,layer,content) select null,'platform','## Identidade: Assistente de teste.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id) insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`,
  );
});
afterAll(() => pool.end());

/** Modelo falso que manda `corpos[n]` no n-ésimo send_message e depois encerra. */
function deps(corpos: string[]) {
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
  delete knobs.compaction;
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
      const enviados = options.prompt
        .filter((m) => m.role === "tool")
        .flatMap((m) => m.content)
        .filter((r) => "toolName" in r && r.toolName === "send_message").length;
      let content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
      >;
      if (!options.tools?.length) {
        // Sem tools = fechamento com checkpoint, que a prévia assistida já não chama.
        const fechamento = {
          rolling_summary: "Fim",
          commitments: [],
          objections: [],
          next_action: null,
        };
        content = [{ type: "text", text: JSON.stringify(fechamento) }];
      } else if (enviados < corpos.length) {
        content = [
          {
            type: "tool-call",
            toolCallId: `envio-${enviados}`,
            toolName: "send_message",
            input: JSON.stringify({ body: corpos[enviados] }),
          },
        ];
      } else {
        content = [{ type: "text", text: "Concluído." }];
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

it("rascunho assistido: envio VETADO volta ao modelo, e o reescrito vira o rascunho", async () => {
  const f = await replyFixture(pool);
  await pool.query(
    "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at) values($1,$2,$3,$4,'inbound','text','received','Qual o horário?','2026-09-07T14:00:00Z')",
    [f.org, f.contact, f.conversation, f.channel],
  );
  await generateReplyDraft(
    pool,
    deps([
      "Chamei crm_list_leads e o atendimento começa às oito horas.",
      "O atendimento começa às nove horas.",
    ]),
    {
      organizationId: f.org,
      conversationId: f.conversation,
      contactId: f.contact,
      channelId: f.channel,
    },
  );
  const { rows } = await pool.query(
    "select status, original_body, error_code from ai_reply_drafts where organization_id=$1 and conversation_id=$2 order by created_at desc limit 1",
    [f.org, f.conversation],
  );
  // O veto aconteceu (é o 1º impedimento registrado) e NÃO encerrou o turno.
  expect(rows[0]).toMatchObject({ status: "pending", error_code: "internal_vocabulary_leak" });
  expect(rows[0]?.original_body).toContain("nove horas");
  expect(rows[0]?.original_body).not.toContain("crm_list_leads");
});
