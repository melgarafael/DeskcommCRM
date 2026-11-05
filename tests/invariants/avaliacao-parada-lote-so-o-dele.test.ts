import { execFileSync } from "node:child_process";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyScheduleFollowup } from "@/lib/agent-engine/agent/schedule-followup";
import { scheduleCronJob } from "@/lib/agent-engine/cron/scheduler";

import { CENARIOS, telefoneDaExecucao } from "../../scripts/lib/avaliacao-parada-apos-envio";
import {
  cancelarRetornosDoLote,
  gastoDoLote,
  MOTIVO_DO_CANCELAMENTO,
  NOME_DO_AGENTE,
} from "../../scripts/lib/avaliacao-parada-apos-envio-pg";

/**
 * O lote da avaliação da parada (scripts/avaliar-parada-apos-envio.ts) só mexe
 * no que é dele — contra Postgres real, porque os dois defeitos moravam no SQL.
 *
 * 1. O TETO soma só o que é do lote.
 *
 * Medido no piloto de 03/11: a prévia dos agentes da avaliação de tokens roda na
 * mesma organização ao mesmo tempo e grava `llm_calls` sem contato e sem job
 * (`agent_preview` com o agente dela; `checkpoint`, `promise_semantic`, … sem
 * agente nenhum). O teto antigo somava toda chamada sem contato desde o início
 * do `executar`, e o lote do B parava — ou acusava cegueira — pelo gasto alheio.
 * O que é do B sem contato é o classificador de sentimento, com `agent_id` do
 * agente da avaliação.
 *
 * 2. Os RETORNOS que o lote agendou são cancelados, e só eles. O S2 ("me chama
 * amanhã às 10h") agenda retorno de verdade — 8 no piloto, cancelados à mão —, e
 * o worker os dispararia no dia seguinte como turnos pagos fora de qualquer teto.
 * Os retornos nascem aqui pelo emissor de produção (`applyScheduleFollowup`, o
 * que o motor roda no turno), não por INSERT à mão.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;
const porta = process.env.TEST_DB_PORT ?? "54329";

function psql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "a7a1b0b0-0000-4000-8000-000000000001";
const AGENTE_B = "a7a1b0b0-0000-4000-8000-0000000000b1";
const AGENTE_C = "a7a1b0b0-0000-4000-8000-0000000000c1";
const SESSAO = "e2e-radar-session";
const S2 = CENARIOS.find((c) => c.id === "S2-casos-off")!;
const DO_LOTE = "a7a1b0b0-0000-4000-8000-000000000a01";
const DE_OUTRO_LOTE = "a7a1b0b0-0000-4000-8000-000000000a02";
const DO_LOTE_CEGO = "a7a1b0b0-0000-4000-8000-000000000a03";
const DO_LOTE_2 = "a7a1b0b0-0000-4000-8000-000000000a04";
const ALHEIO = "a7a1b0b0-0000-4000-8000-000000000a05";
const DESDE = new Date("2026-11-03T12:00:00Z");
const depois = (min: number) => new Date(DESDE.getTime() + min * 60_000).toISOString();

let pool: pg.Pool;

beforeAll(() => {
  psql(`
    insert into organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'aval-parada', 'Avaliação', 'Avaliação');
    insert into channel_sessions (organization_id, waha_session_name, display_name, status, webhook_secret_encrypted)
    values ('${ORG}', '${SESSAO}', 'Avaliação da parada', 'WORKING', '\\x00');
    insert into ai_agents (id, organization_id, name, system_prompt) values
      ('${AGENTE_B}', '${ORG}', '${NOME_DO_AGENTE}', 'p'),
      ('${AGENTE_C}', '${ORG}', 'Avaliação de tokens — clinica', 'p');
    insert into contacts (id, organization_id, name, phone_number) values
      ('${DO_LOTE}', '${ORG}', 'lote 89', '+${telefoneDaExecucao(89, S2, "off", 1)}'),
      ('${DE_OUTRO_LOTE}', '${ORG}', 'lote 90', '+${telefoneDaExecucao(90, S2, "off", 1)}'),
      ('${DO_LOTE_CEGO}', '${ORG}', 'lote 88', '+${telefoneDaExecucao(88, S2, "off", 1)}'),
      ('${DO_LOTE_2}', '${ORG}', 'lote 89 #2', '+${telefoneDaExecucao(89, S2, "observe", 2)}'),
      ('${ALHEIO}', '${ORG}', 'cliente de verdade', '+5531999990000');

    insert into llm_calls (organization_id, purpose, provider, model, contact_id, agent_id, input_tokens, output_tokens, cost_cents, created_at) values
      -- do lote 89: o turno do contato, e o sentimento do agente B sem contato
      ('${ORG}', 'agent_turn', 'openai', 'gpt-5.6-luna', '${DO_LOTE}', '${AGENTE_B}', 900, 40, 10, '${depois(1)}'),
      ('${ORG}', 'sentiment_classify', 'openai', 'gpt-5.6-luna', null, '${AGENTE_B}', 200, 5, 3, '${depois(2)}'),
      -- do agente B, mas de antes deste executar
      ('${ORG}', 'sentiment_classify', 'openai', 'gpt-5.6-luna', null, '${AGENTE_B}', 200, 5, 7, '${depois(-5)}'),
      -- da prévia do C/F5: com o agente dela, e os auxiliares sem agente — um deles CEGO
      ('${ORG}', 'agent_preview', 'anthropic', 'claude-sonnet-4-6', null, '${AGENTE_C}', 9000, 300, 100, '${depois(3)}'),
      ('${ORG}', 'checkpoint', 'anthropic', 'claude-sonnet-4-6', null, null, 4000, 200, 50, '${depois(3)}'),
      ('${ORG}', 'promise_semantic', 'anthropic', 'claude-sonnet-4-6', null, null, 500, 20, null, '${depois(4)}'),
      -- de outro lote
      ('${ORG}', 'agent_turn', 'openai', 'gpt-5.6-luna', '${DE_OUTRO_LOTE}', '${AGENTE_B}', 900, 40, 1000, '${depois(1)}'),
      -- do lote 88: tokens sem custo
      ('${ORG}', 'agent_turn', 'openai', 'gpt-5.6-luna', '${DO_LOTE_CEGO}', '${AGENTE_B}', 900, 40, null, '${depois(1)}');
  `);
  pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${porta}/postgres`, max: 2 });
});

afterAll(async () => {
  await pool?.end();
});

describe("teto do lote da parada — soma só o que é do lote", () => {
  it("o contato do lote e o sem-contato do agente avaliado entram; a prévia de outro agente, não", async () => {
    // Antes: 10 + 3 + 100 + 50 = 163 centavos e 1 chamada cega (a da prévia).
    expect(await gastoDoLote(pool, 89, DESDE, SESSAO)).toEqual({ centavos: 13, chamadasCegas: 0 });
  });

  it("chamada do lote com tokens e sem custo continua cegando o teto (falha fechado)", async () => {
    const g = await gastoDoLote(pool, 88, DESDE, SESSAO);
    expect(g.chamadasCegas).toBe(1);
  });
});

describe("retornos do lote — cancelados pela regra do produto, só os do lote", () => {
  it("cancela os retornos dos contatos do lote e deixa o resto agendado", async () => {
    const agora = new Date();
    const emDoisDias = new Date(agora.getTime() + 2 * 86_400_000).toISOString();
    const janela = { minAheadMs: 300_000, maxAheadMs: 15_552_000_000, staggerWindowMs: 0 };
    for (const contato of [DO_LOTE, DO_LOTE_2, DE_OUTRO_LOTE, ALHEIO]) {
      const r = await applyScheduleFollowup(
        pool,
        { clock: () => agora, knobs: janela },
        { tenantId: ORG, leadId: contato, agentId: AGENTE_B },
        { reason: "cliente pediu para chamar amanhã às 10h", promised_at: emDoisDias, promise: "te chamo amanhã às 10h", context_snapshot: null },
      );
      expect(r.ok).toBe(true);
    }
    // Um cron do contato do lote que NÃO é retorno.
    await scheduleCronJob(pool, ORG, { leadId: DO_LOTE, spec: { kind: "every", intervalMs: 3_600_000 }, jobKind: "watchdog", staggerWindowMs: 0 });

    expect(await cancelarRetornosDoLote(pool, 89, agora)).toBe(2);
    expect(await cancelarRetornosDoLote(pool, 89, agora)).toBe(0);

    const linhas = psql(`
      select c.name || '|' || j.job_kind || '|' || j.enabled::text || '|' || coalesce(j.cancel_reason, '-') || '|' || (j.cancelled_at is not null)::text
        from cron_jobs j join contacts c on c.id = j.contact_id
       where j.organization_id = '${ORG}';
    `).split("\n");
    expect(linhas.sort()).toEqual(
      [
        `lote 89|followup_turn|false|${MOTIVO_DO_CANCELAMENTO}|true`,
        `lote 89 #2|followup_turn|false|${MOTIVO_DO_CANCELAMENTO}|true`,
        "lote 89|watchdog|true|-|false",
        "lote 90|followup_turn|true|-|false",
        "cliente de verdade|followup_turn|true|-|false",
      ].sort(),
    );
  });
});
