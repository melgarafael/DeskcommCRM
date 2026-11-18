/**
 * AS NOTAS DO CONTATO NA PRÉVIA TÊM TETO (frente F1), pelo caminho de produção:
 * `generateReplyDraft` (o rascunho do modo assistido) → `runAgentPreview` →
 * o turno real em modo prévia, com o modelo de mentira do repositório.
 *
 * Antes, a prévia colava TODAS as notas (headline + corpo) no prompt, sem
 * limite nenhum — ignorava o orçamento do índice que o turno real respeita. O
 * conserto não muda nada no caso comum:
 *
 *  - CONTROLE: notas pequenas continuam inteiras no prompt, no formato de
 *    sempre, e `get_lead_note` devolve todas elas, sem o id, como antes;
 *  - acima do teto inline, a prévia usa o índice do turno real (`- [id] headline`,
 *    sem corpo nenhum) e `get_lead_note` devolve UM corpo pelo id.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
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

/**
 * Deps do turno com um modelo de mentira que, no primeiro passo, chama
 * `get_lead_note` com `noteId` e, no seguinte, propõe a resposta. Todo prompt
 * enviado ao modelo fica em `prompts` para o teste ler.
 */
function deps(prompts: string[], noteId: string, envExtra: Record<string, string> = {}) {
  const knobs = turnKnobsFromEnv(
    loadEnv({
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
      ...envExtra,
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
      prompts.push(JSON.stringify(options.prompt));
      const uso = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      // Chamada sem ferramentas (auxiliar): só texto, como o modelo de verdade.
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
      const resultados = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content);
      const viu = (n: string) => resultados.some((r) => "toolName" in r && r.toolName === n);
      const tem = (n: string) => options.tools?.some((t) => t.type === "function" && t.name === n);
      const nome =
        tem("get_lead_note") && !viu("get_lead_note")
          ? "get_lead_note"
          : !viu("send_message")
            ? "send_message"
            : null;
      const content = nome
        ? [
            {
              type: "tool-call" as const,
              toolCallId: randomUUID(),
              toolName: nome,
              input: JSON.stringify(
                nome === "get_lead_note" ? { note_id: noteId } : { body: "Anotado, obrigado!" },
              ),
            },
          ]
        : [{ type: "text" as const, text: "Concluído." }];
      return {
        content,
        finishReason: { unified: nome ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
        usage: uso,
        warnings: [],
      };
    }),
  };
}

async function rascunho(
  notas: Array<{ headline: string; body: string }>,
  envExtra: Record<string, string> = {},
) {
  const f = await replyFixture(pool);
  await pool.query(
    "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at) values($1,$2,$3,$4,'inbound','text','received','Bom dia, tudo bem?','2026-09-07T14:00:00Z')",
    [f.org, f.contact, f.conversation, f.channel],
  );
  const ids: string[] = [];
  for (const n of notas) {
    ids.push(
      (
        await pool.query<{ id: string }>(
          "insert into lead_notes(organization_id,contact_id,headline,body) values($1,$2,$3,$4) returning id::text as id",
          [f.org, f.contact, n.headline, n.body],
        )
      ).rows[0]!.id,
    );
  }
  const prompts: string[] = [];
  await generateReplyDraft(pool, deps(prompts, ids[0] ?? "", envExtra) as never, {
    organizationId: f.org,
    conversationId: f.conversation,
    contactId: f.contact,
    channelId: f.channel,
  });
  return { prompts, ids };
}

/** O prompt de abertura do turno — o que carrega o bloco de memória do lead. */
function abertura(prompts: string[]): string {
  const p = prompts.find((x) => x.includes("Memória do lead"));
  expect(p, "nenhum prompt levou a abertura do turno").toBeDefined();
  return p!;
}

/**
 * O RESULTADO do get_lead_note, como ele chegou ao modelo no passo seguinte —
 * só a saída da ferramenta, não a chamada (que também leva `note_id`).
 */
function resultadoDoGetLeadNote(prompts: string[]): string {
  for (const p of prompts) {
    const mensagens = JSON.parse(p) as Array<{ role: string; content: unknown }>;
    for (const m of mensagens) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      const item = (m.content as Array<{ toolName?: string; output?: unknown }>).find(
        (c) => c.toolName === "get_lead_note",
      );
      if (item) return JSON.stringify(item.output);
    }
  }
  throw new Error("o get_lead_note não chegou a responder");
}

it("CONTROLE: notas pequenas vão inteiras no prompt, e get_lead_note devolve todas, como antes", async () => {
  const { prompts } = await rascunho([
    { headline: "Prefere manhã", body: "CORPO-SENTINELA-91" },
    { headline: "Tem filho", body: "CORPO-SENTINELA-92" },
  ]);
  expect(abertura(prompts)).toContain("Prefere manhã: CORPO-SENTINELA-91");
  expect(abertura(prompts)).toContain("Tem filho: CORPO-SENTINELA-92");
  const resposta = resultadoDoGetLeadNote(prompts);
  expect(resposta).toContain('"notes":[{"headline":"Prefere manhã","body":"CORPO-SENTINELA-91"}');
  expect(resposta).not.toContain('"note_id"');
});

it("acima do teto inline, o prompt leva o índice sem corpo, e get_lead_note busca UM corpo pelo id", async () => {
  const { prompts, ids } = await rascunho(
    [0, 1, 2, 3].map((i) => ({ headline: `Nota ${i}`, body: `CORPO-LONGO-${i} ` + "x".repeat(3_980) })),
  );
  const inicio = abertura(prompts);
  expect(inicio).toContain(`- [${ids[0]}] Nota 0`);
  expect(inicio).toContain(`- [${ids[3]}] Nota 3`);
  expect(inicio).not.toContain("CORPO-LONGO-");
  const resposta = resultadoDoGetLeadNote(prompts);
  expect(resposta).toContain(`"note_id":"${ids[0]}"`);
  expect(resposta).toContain("CORPO-LONGO-0");
  expect(resposta).not.toContain("CORPO-LONGO-1");
});

/**
 * O knob do histórico (frente F5) pelo MESMO caminho: env → `turnKnobsFromEnv`
 * → abertura do turno. O prompt aqui é o `JSON.stringify` da conversa, então as
 * aspas do texto chegam escapadas (`\\"`).
 */
it("LEAD_CONTEXT_HISTORY_FORMAT: ausente = histórico em JSON; linhas = uma linha por mensagem", async () => {
  const comoSempre = abertura((await rascunho([])).prompts);
  expect(comoSempre).toContain('\\"de\\":\\"cliente\\"');
  expect(comoSempre).not.toContain("Mensagens (da mais antiga para a mais recente):");

  const emLinhas = abertura((await rascunho([], { LEAD_CONTEXT_HISTORY_FORMAT: "linhas" })).prompts);
  expect(emLinhas).toContain("Mensagens (da mais antiga para a mais recente):");
  expect(emLinhas).toContain('] cliente: \\"Bom dia, tudo bem?\\"');
  expect(emLinhas).not.toContain('\\"de\\":\\"cliente\\"');
});
