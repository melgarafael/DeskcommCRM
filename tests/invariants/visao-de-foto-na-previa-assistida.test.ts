/**
 * A PRÉVIA VÊ O QUE O TURNO REAL VERIA — "ver as fotos" (migration 9108), pelo
 * caminho de produção do "Sugerir resposta": `generateReplyDraft` →
 * `runAgentPreview` → o turno real em modo prévia, com o modelo de mentira.
 *
 * A conversa tem uma foto JÁ descrita (outro leitor da empresa a pediu). O
 * agente com a opção desligada não recebe a descrição: recebe o aviso de
 * imagem não vista, como no turno do `inbound_turn`. CONTROLE: com a opção
 * ligada (o padrão) a descrição entra, como antes.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { MARCADOR_IMAGEM_NAO_VISTA } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

const DESCRICAO = "Comprovante de PIX de R$ 350,00 para a Loja Sentinela";

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
  delete knobs.compaction;
  const uso = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return {
    crmCfg: { supabase: createClient("http://127.0.0.1:1", "test-key") },
    llmCfg: { anthropicApiKey: "fake-local" },
    knobs,
    log: createLogger(),
    clock: () => new Date("2026-09-07T15:00:00Z"),
    embed: async () => ({ embedding: Array(1536).fill(0.1), promptTokens: 0, model: "text-embedding-3-small" }),
    registry: createFakeRegistry(async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      if (!options.tools?.length)
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ rolling_summary: "x", commitments: [], objections: [], next_action: null }),
            },
          ],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: uso,
          warnings: [],
        };
      const enviou = options.prompt.some(
        (m) => m.role === "tool" && JSON.stringify(m.content).includes('"toolName":"send_message"'),
      );
      return {
        content: enviou
          ? [{ type: "text" as const, text: "Concluído." }]
          : [
              {
                type: "tool-call" as const,
                toolCallId: randomUUID(),
                toolName: "send_message",
                input: JSON.stringify({ body: "Recebi, obrigado!" }),
              },
            ],
        finishReason: { unified: enviou ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
        usage: uso,
        warnings: [],
      };
    }),
  };
}

async function previa(imageVisionEnabled: boolean) {
  const f = await replyFixture(pool);
  await pool.query(
    `insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at,
                          media_url,media_mime,media_storage_path,media_derived_text,media_derived_status)
     values($1,$2,$3,$4,'inbound','image','received',null,'2026-09-07T14:00:00Z',
            'http://waha/files/x.jpg','image/jpeg',$5,$6,'ready')`,
    [f.org, f.contact, f.conversation, f.channel, `${f.org}/${f.conversation}/x.jpg`, DESCRICAO],
  );
  const config = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
  expect(config, "a versão da fixture precisa carregar").not.toBeNull();
  const prompts: string[] = [];
  await generateReplyDraft(pool, deps(prompts) as never, {
    organizationId: f.org,
    conversationId: f.conversation,
    contactId: f.contact,
    channelId: f.channel,
    agent: { ...config!, imageVisionEnabled },
  });
  const turnoDoAgente = prompts.find((p) => p.includes("Memória do lead"));
  expect(turnoDoAgente, "o turno do agente não chegou ao modelo").toBeDefined();
  return turnoDoAgente!;
}

const noPrompt = (s: string) => JSON.stringify(s).slice(1, -1);

it("opção desligada: a prévia recebe o aviso, não a descrição da foto", async () => {
  const prompt = await previa(false);
  expect(prompt, "a prévia viu a foto que o turno real não veria").not.toContain("Loja Sentinela");
  expect(prompt).toContain(noPrompt(MARCADOR_IMAGEM_NAO_VISTA));
});

it("CONTROLE: opção ligada — a descrição entra, como antes", async () => {
  const prompt = await previa(true);
  expect(prompt).toContain("Loja Sentinela");
  expect(prompt).not.toContain(noPrompt(MARCADOR_IMAGEM_NAO_VISTA));
});
