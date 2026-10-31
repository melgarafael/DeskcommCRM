import { randomUUID } from "node:crypto";

import type { FinishReason } from "ai";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { createInboundTurnHandler, type InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { crmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/crm/mcp-client";
import { llmEdgeConfigFromEnv, LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";
import { CORRECAO_DO_TURNO_MUDO } from "@/lib/agent-engine/agent/turno-mudo";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import * as queue from "@/lib/agent-engine/queue/queue";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";

/**
 * PROPOSTA SOB PEDIDO — "Sugerir resposta" propõe um texto quando o turno
 * automático calaria (#3281), pelo caminho REAL das duas pontas.
 *
 * O caso medido pelo autor da issue: a clínica responde primeiro com o aviso
 * automático do WhatsApp Business, o agente cala (certo) e, mais de uma hora
 * depois, chegam escritas por uma PESSOA "Bom dia!" e "Como posso ajudar?". O
 * prompt de recepção lia as duas como robô, o turno automático terminou com
 * `messages_sent: 0` e **Sugerir resposta** devolveu o mesmo vazio: o operador
 * teve de escrever à mão — justamente no momento em que sabia mais que a regra.
 *
 * O dublê de modelo é roteirizado pela CONVERSA, não pelo índice da chamada:
 * ele cala enquanto o prompt não traz o pedido humano, e escreve quando traz.
 * Assim o MESMO cenário mede as três pontas:
 *
 * 1. ⛔ prévia assistida → proposta de texto (o rascunho do operador);
 * 2. CONTROLE: turno automático → continua em silêncio, e a instrução não chega
 *    nele (é o `preview?.kind === 'assisted'` que a prende ao rascunho);
 * 3. CONTROLE "nada a responder": conversa já respondida → prévia continua
 *    vazia, com `no_candidate`.
 *
 * Estes são controles de backend/SQL com modelo roteirizado, não a prova de
 * UI nem o par completo de `docs/doctrine/prova-em-par.md`. O botão, a revisão
 * e a aprovação têm jornada própria no harness de autonomia assistida.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});
const orgsCriadas: string[] = [];

/**
 * A marca da instrução do pedido humano — o que o dublê escuta.
 *
 * Sem aspas de propósito: o dublê olha o prompt SERIALIZADO (`JSON.stringify`),
 * e uma marca com `"` viraria `\"` e nunca casaria — foi assim que a primeira
 * corrida do teste passou pelo passo novo e o dublê continuou calado.
 */
const MARCA_DO_PEDIDO = "pediu um texto para esta conversa";
const TEXTO_PROPOSTO = "Bom dia! Posso ajudar com o seu pedido?";
const FECHAMENTO = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "t",
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const calado = (finishReason: FinishReason = "stop") => ({
  content: [{ type: "text" as const, text: "" }],
  finishReason: { unified: finishReason, raw: undefined },
  usage: USO,
  warnings: [],
});
const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviar = (body: string) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `c-${randomUUID()}`,
      toolName: "send_message",
      input: JSON.stringify({ body }),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});

/**
 * O agente do cenário: com a regra de silêncio do prompt, ele CALA enquanto
 * ninguém disser que uma pessoa pediu o texto. É o dublê da issue.
 */
interface CenarioDoModelo {
  textoSolto?: boolean;
  antesDoSilencio?: () => Promise<void>;
  chamadasComFerramentas?: string[];
  finishReason?: FinishReason;
}

function modelo(prompts: string[], cenario: CenarioDoModelo) {
  return createFakeRegistry(async (options) => {
    const prompt = JSON.stringify(options.prompt);
    prompts.push(prompt);
    if (!options.tools?.length) return texto(FECHAMENTO);
    cenario.chamadasComFerramentas?.push(prompt);
    if (prompt.includes(MARCA_DO_PEDIDO)) return enviar(TEXTO_PROPOSTO);
    if (cenario.antesDoSilencio) await cenario.antesDoSilencio();
    const correcao = JSON.stringify(CORRECAO_DO_TURNO_MUDO).slice(1, -1);
    return cenario.textoSolto && !prompt.includes(correcao)
      ? texto(TEXTO_PROPOSTO) : calado(cenario.finishReason);
  });
}

function deps(prompts: string[], cenario: CenarioDoModelo = {}): InboundTurnDeps {
  const ambiente = loadEnv({
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    });
  const knobs = turnKnobsFromEnv(ambiente);
  delete knobs.stageClassifier;
  delete knobs.jailbreak;
  delete knobs.promiseSemantic;
  delete knobs.compaction;
  return {
    crmCfg: crmEdgeConfigFromEnv({
      SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    }),
    llmCfg: { ...llmEdgeConfigFromEnv(ambiente), anthropicApiKey: "test-key" },
    knobs,
    log: createLogger(),
    // Relógio REAL: as mensagens do cenário nascem com `now()`. Fixar o relógio
    // no passado fecharia a janela de 24 h contra elas e o veto de janela
    // mascararia o que este teste mede.
    clock: () => new Date(),
    embed: async () => ({ embedding: Array(1536).fill(0.1), promptTokens: 0, model: "stub" }),
    registry: modelo(prompts, cenario),
  };
}

/** A rajada de uma PESSOA, depois do aviso automático — o caso da issue. */
async function rajadaDaPessoa(f: {
  org: string;
  conversation: string;
  channel: string;
  contact: string;
}) {
  for (const body of ["Bom dia!", "Como posso ajudar?"])
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
      [randomUUID(), f.org, f.conversation, f.channel, f.contact, body],
    );
}

/** O rascunho mais recente da conversa — o que a tela do operador lê. */
async function ultimoRascunho(org: string, conversation: string) {
  const { rows } = await pool.query<{
    status: string;
    original_body: string | null;
    error_code: string | null;
  }>(
    `select status, original_body, error_code from ai_reply_drafts
      where organization_id=$1 and conversation_id=$2 order by created_at desc limit 1`,
    [org, conversation],
  );
  return rows[0];
}

/**
 * O agente do CENÁRIO é automático — o da issue respondia sozinho e um humano
 * clicou em "Sugerir resposta" na mesma conversa. Sem isto o turno automático
 * nem roda (`inbound-turn.ts`: `operationMode === 'assisted'` devolve cedo), e o
 * controle "o automático segue calado" passaria por não ter acontecido nada.
 */
async function fixtureAutomática() {
  const f = await replyFixture(pool);
  orgsCriadas.push(f.org);
  await pool.query(`update ai_agents set operation_mode='automatic' where id=$1`, [f.agent]);
  // O relógio é REAL (ver `deps`), então a janela de RESPOSTA do canal tem de
  // cobrir o dia inteiro: com a padrão (7h-22h), rodar de madrugada no fuso do
  // canal fazia o `outside_window` vetar a proposta e o teste ficar vermelho
  // pela hora do relógio, não pelo motor. Mesmo recurso de
  // `janela-de-resposta-no-turno.test.ts`.
  await pool.query(
    `insert into channel_knobs (organization_id, channel_session_id, resposta_start_hour, resposta_end_hour, allow_sunday)
     values ($1, $2, 0, 24, true)
     on conflict (organization_id, channel_session_id)
     do update set resposta_start_hour = 0, resposta_end_hour = 24, allow_sunday = true`,
    [f.org, f.channel],
  );
  return f;
}

/** O turno AUTOMÁTICO de verdade: job na fila + handler de `inbound_turn`. */
async function turnoAutomatico(
  f: { org: string; contact: string; conversation: string; channel: string },
  prompts: string[],
  chamadasComFerramentas: string[],
) {
  const enviados: string[] = [];
  const msg = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Como posso ajudar?','external_device',now(),now())`,
    [msg, f.org, f.conversation, f.channel, f.contact],
  );
  const { job } = await queue.enqueueJob(pool, f.org, {
    kind: "inbound_turn",
    leadId: f.contact,
    payload: {
      conversation_id: f.conversation,
      contact_id: f.contact,
      channel_session_id: f.channel,
      inbound_message_id: msg,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  // Só a aquisição é controlada pela fixture. Não tomar um job de outra
  // organização da suíte; enqueue, handler, regras e conclusão continuam reais.
  const { rows: claimedRows } = await pool.query<queue.JobRow>(
    `update job_queue j set status='running',locked_by='pedido',locked_at=clock_timestamp(),
       attempts=attempts+1 where organization_id=$1 and id=$2 and status='pending'
     returning j.*,j.locked_at::text claim_acquired_at`,
    [f.org, job.id],
  );
  const claimed = claimedRows[0];
  expect(claimed?.id).toBe(job.id);
  const handler = createInboundTurnHandler({
    ...deps(prompts, { chamadasComFerramentas }),
    channel: () =>
      ({
        channel: "captura",
        send: async (input: { body: string }) => {
          enviados.push(input.body);
          return {
            kind: "sent" as const,
            idempotencyKey: `k${enviados.length}`,
            messageId: `m${enviados.length}`,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING", since: null }),
        capabilities: () => ({ freeformAnytime: true, serviceWindowHours: null }),
        costPerMessage: () => ({ perMessageUsdCents: 0, model: "flat" }),
      }),
    sleep: async () => {},
  });
  if (!claimed) throw new Error("O job próprio do cenário não foi adquirido.");
  await handler(claimed, pool, { workerId: "pedido" });
  await queue.completeJob(pool, claimed.id, "pedido");
  return enviados;
}

beforeAll(async () => {
  await seedGov();
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

afterAll(async () => {
  try {
    if (orgsCriadas.length) await pool.query(
      "delete from organizations where id=any($1::uuid[])", [orgsCriadas],
    );
  } finally {
    await pool.end();
  }
});

describe("Sugerir resposta propõe quando o agente automático calaria (#3281)", () => {
  it("⛔ a rajada de uma PESSOA vira proposta de texto no rascunho, e o automático segue calado", async () => {
    const f = await fixtureAutomática();
    await rajadaDaPessoa(f);
    const agent = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
    if (!agent) throw new Error("O agente publicado do cenário não foi carregado.");

    // ── ponta 1: o rascunho do operador ────────────────────────────────────
    const promptsRascunho: string[] = [];
    await generateReplyDraft(pool, deps(promptsRascunho), {
      organizationId: f.org,
      conversationId: f.conversation,
      contactId: f.contact,
      channelId: f.channel,
      agent,
    });

    const rascunho = await ultimoRascunho(f.org, f.conversation);
    expect(
      rascunho?.original_body,
      `cliquei em Sugerir resposta e continuou vazio (status=${rascunho?.status}, code=${
        rascunho?.error_code
      }, chamadas=${promptsRascunho.length}, instrucao_na_2a=${String(
        promptsRascunho[1]?.includes(MARCA_DO_PEDIDO),
      )})`,
    ).toBe(TEXTO_PROPOSTO);
    expect(rascunho?.status, "proposta pronta não pode nascer como falha").toBe("pending");
    // A 1ª chamada é o turno como o automático o faria — sem a instrução.
    expect(promptsRascunho[0]).not.toContain(MARCA_DO_PEDIDO);
    // A instrução do pedido humano só aparece DEPOIS de o turno calar.
    expect(promptsRascunho[1]).toContain(MARCA_DO_PEDIDO);

    // ── ponta 2 (controle): o MESMO cenário, pelo turno automático ─────────
    const promptsTurno: string[] = [];
    const chamadasAutomaticas: string[] = [];
    const enviados = await turnoAutomatico(f, promptsTurno, chamadasAutomaticas);
    // O controle precisa alcançar o modelo: primeiro turno + uma correção
    // canônica. Silêncio por early-return não prova preservação do automático.
    expect(chamadasAutomaticas).toHaveLength(2);
    expect(enviados, "o turno automático passou a falar sozinho").toEqual([]);
    expect(
      promptsTurno.some((p) => p.includes(MARCA_DO_PEDIDO)),
      "a instrução do pedido humano vazou para o turno automático",
    ).toBe(false);
  });

  it("CONTROLE 'nada a responder': conversa já respondida mantém a prévia vazia", async () => {
    const f = await fixtureAutomática();
    // Um inbound e a resposta que já o atendeu: não há o que propor.
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text','inbound','delivered','Bom dia!','external_device',now(),now())`,
      [randomUUID(), f.org, f.conversation, f.channel, f.contact],
    );
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text','outbound','sent','Bom dia! Como posso ajudar?','crm',now(),now())`,
      [randomUUID(), f.org, f.conversation, f.channel, f.contact],
    );
    const agent = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
    if (!agent) throw new Error("O agente publicado do cenário não foi carregado.");

    const prompts: string[] = [];
    await generateReplyDraft(pool, deps(prompts), {
      organizationId: f.org,
      conversationId: f.conversation,
      contactId: f.contact,
      channelId: f.channel,
      agent,
    });

    // Sem inbound pendente o motor NÃO pede a proposta: a instrução não é
    // enviada, e o rascunho fica como hoje (vazio, com o motivo na tela).
    expect(
      prompts.some((p) => p.includes(MARCA_DO_PEDIDO)),
      "pediu proposta numa conversa que já foi respondida",
    ).toBe(false);
    const rascunho = await ultimoRascunho(f.org, f.conversation);
    expect(rascunho?.original_body ?? "").toBe("");
    expect(rascunho?.status).toBe("failed");
    expect(rascunho?.error_code).toBe("no_candidate");
  });

  it("texto solto usa uma correção canônica e não ganha terceira chamada", async () => {
    const f = await fixtureAutomática();
    await rajadaDaPessoa(f);
    const agent = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
    if (!agent) throw new Error("O agente publicado do cenário não foi carregado.");
    const prompts: string[] = [];
    const chamadas: string[] = [];
    await generateReplyDraft(pool, deps(prompts, {
      textoSolto: true,
      chamadasComFerramentas: chamadas,
    }), {
      organizationId: f.org,
      conversationId: f.conversation,
      contactId: f.contact,
      channelId: f.channel,
      agent,
    });
    expect(chamadas).toHaveLength(2);
    expect(prompts.some((p) => p.includes(MARCA_DO_PEDIDO))).toBe(false);
    expect(await ultimoRascunho(f.org, f.conversation)).toMatchObject({
      status: "failed", original_body: "", error_code: "no_candidate",
    });
  });

  it.each<FinishReason>(["content-filter", "error", "other"])(
    "término vazio %s não recebe pedido humano nem outra chamada com ferramentas",
    async (finishReason) => {
      const f = await fixtureAutomática();
      await rajadaDaPessoa(f);
      const agent = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
      if (!agent) throw new Error("O agente publicado do cenário não foi carregado.");
      const prompts: string[] = [];
      const chamadas: string[] = [];
      await generateReplyDraft(pool, deps(prompts, {
        finishReason,
        chamadasComFerramentas: chamadas,
      }), {
        organizationId: f.org,
        conversationId: f.conversation,
        contactId: f.contact,
        channelId: f.channel,
        agent,
      });
      expect(chamadas).toHaveLength(1);
      expect(prompts.some((p) => p.includes(MARCA_DO_PEDIDO))).toBe(false);
      expect(await ultimoRascunho(f.org, f.conversation)).toMatchObject({
        status: "failed", original_body: "", error_code: "no_candidate",
      });
    },
  );

  it("orçamento esgotado antes da recuperação impede a segunda ida ao provedor", async () => {
    const f = await fixtureAutomática();
    await rajadaDaPessoa(f);
    const agent = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
    if (!agent) throw new Error("O agente publicado do cenário não foi carregado.");
    const prompts: string[] = [];
    const chamadas: string[] = [];
    await expect(generateReplyDraft(pool, deps(prompts, {
      chamadasComFerramentas: chamadas,
      antesDoSilencio: async () => {
        // Estado sintético no banco próprio: a primeira geração já foi admitida.
        // A configuração do orçamento muda antes de pedir a recuperação.
        await pool.query(`insert into ai_budgets
          (organization_id,monthly_limit_cents,enforcement_mode,enforcement_effective_at)
          values($1,1000,'bloquear',now()-interval '1 day')
          on conflict(organization_id) do update set monthly_limit_cents=1000,
            enforcement_mode='bloquear',enforcement_effective_at=excluded.enforcement_effective_at`,
          [f.org]);
        await pool.query(`insert into llm_calls
          (organization_id,purpose,provider,model,cost_cents,status)
          values($1,'fixture_budget_control','anthropic','test-model',2000,'ok')`, [f.org]);
        // O gate só bloqueia quem JÁ foi avisado neste mês (`decidirOrcamento`,
        // regra 7: o primeiro cruzamento avisa e segue). Sem o aviso anterior,
        // a recuperação seria exatamente esse primeiro cruzamento e passaria.
        await pool.query(`insert into agent_inbox_items
          (organization_id,kind,severity,title,body)
          values($1,'budget_warning','warn','O gasto de IA passou do aviso','fixture')`, [f.org]);
      },
    }), {
      organizationId: f.org,
      conversationId: f.conversation,
      contactId: f.contact,
      channelId: f.channel,
      agent,
    })).rejects.toThrow(LlmBudgetExceededError);
    expect(chamadas).toHaveLength(1);
    expect(prompts.some((p) => p.includes(MARCA_DO_PEDIDO))).toBe(false);
    const refusal = await pool.query<{ n: number }>(
      "select count(*)::int n from llm_calls where organization_id=$1 and purpose='agent_preview' and error_code='orcamento_esgotado'",
      [f.org],
    );
    expect(refusal.rows).toEqual([{ n: 1 }]);
    expect(await ultimoRascunho(f.org, f.conversation)).toMatchObject({
      status: "failed", error_code: "generation_failed",
    });
  });

});
