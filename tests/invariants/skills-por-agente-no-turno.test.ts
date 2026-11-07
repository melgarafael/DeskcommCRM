/**
 * O TURNO SÓ VÊ AS SKILLS DO AGENTE (frente F3, migration 9107), pelo caminho de
 * produção: `generateReplyDraft` → `runAgentPreview` → o turno real em modo
 * prévia, com o modelo de mentira do repositório.
 *
 * Duas metades do mesmo filtro, e as duas eram o defeito medido (uma skill de
 * clínica entrou seis vezes no agente de imóveis):
 *
 *  - o ÍNDICE no prompt do sistema (`- nome: descrição`) só lista as escolhidas;
 *  - o MATCHER não injeta o corpo (`### nome`) de skill de fora da lista, mesmo
 *    com a palavra-chave dela na mensagem.
 *
 * CONTROLE: com `skillNames: null` (o padrão de toda versão) as duas aparecem,
 * exatamente como antes.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

const ALFA = "skill-alfa-sentinela";
const BETA = "skill-beta-sentinela";

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
    embed: async () => ({
      embedding: Array(1536).fill(0.1),
      promptTokens: 0,
      model: "text-embedding-3-small",
    }),
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
                input: JSON.stringify({ body: "Claro, vamos ver isso." }),
              },
            ],
        finishReason: { unified: enviou ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
        usage: uso,
        warnings: [],
      };
    }),
  };
}

/** Rascunho do assistido com as duas skills na org e as duas palavras na mensagem. */
async function turno(skillNames: string[] | null) {
  const f = await replyFixture(pool);
  for (const [nome, palavra] of [
    [ALFA, "palavraalfa"],
    [BETA, "palavrabeta"],
  ] as const) {
    const versao = randomUUID();
    await pool.query(
      "insert into skill_versions(id,organization_id,name,description,body,matcher) values($1,$2,$3,$4,$5,$6)",
      [versao, f.org, nome, `descrição de ${nome}`, `corpo de ${nome}`, { any_keywords: [palavra] }],
    );
    await pool.query("insert into skill_pointers(organization_id,name,version_id) values($1,$2,$3)", [
      f.org,
      nome,
      versao,
    ]);
  }
  await pool.query(
    "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at) values($1,$2,$3,$4,'inbound','text','received','oi, palavraalfa e palavrabeta','2026-09-07T14:00:00Z')",
    [f.org, f.contact, f.conversation, f.channel],
  );
  const config = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
  expect(config, "a versão da fixture precisa carregar").not.toBeNull();
  const prompts: string[] = [];
  await generateReplyDraft(pool, deps(prompts) as never, {
    organizationId: f.org,
    conversationId: f.conversation,
    contactId: f.contact,
    channelId: f.channel,
    // A escolha da versão chega ao turno pela config publicada — a mesma que
    // `loadAgentVersionConfig` monta; aqui só a lista muda entre os casos.
    agent: { ...config!, skillNames },
  });
  const turnoDoAgente = prompts.find((p) => p.includes("Memória do lead"));
  expect(turnoDoAgente, "o turno do agente não chegou ao modelo").toBeDefined();
  return turnoDoAgente!;
}

it("CONTROLE: skillNames null (todas) — índice e corpo das duas skills, como antes", async () => {
  const prompt = await turno(null);
  expect(prompt).toContain(`- ${ALFA}:`);
  expect(prompt).toContain(`- ${BETA}:`);
  expect(prompt).toContain(`### ${ALFA}`);
  expect(prompt).toContain(`### ${BETA}`);
});

it("lista própria: o índice e o matcher só veem a skill escolhida", async () => {
  const prompt = await turno([ALFA]);
  expect(prompt).toContain(`- ${ALFA}:`);
  expect(prompt).toContain(`### ${ALFA}`);
  expect(prompt, "o índice listou skill de fora da lista").not.toContain(`- ${BETA}:`);
  expect(prompt, "o matcher injetou o corpo de skill de fora da lista").not.toContain(`### ${BETA}`);
});

it("lista vazia: nenhuma skill — nem índice, nem corpo", async () => {
  const prompt = await turno([]);
  expect(prompt).not.toContain(`- ${ALFA}:`);
  expect(prompt).not.toContain(`### ${BETA}`);
  expect(prompt).not.toContain("=== skills (índice");
});
