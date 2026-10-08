/**
 * PONTE WACALLS: a ligação ATENDIDA de um contato bloqueado fica na timeline.
 *
 * Irmão de `voz-recusa-bloqueado.test.ts`, que prova o outro lado: a PERDIDA
 * de bloqueado não abre aviso nem carimba a timeline (recusar é
 * não-interação). Quando alguém da equipe atende, a conversa aconteceu — ela
 * entra no histórico do negócio como qualquer outra. Continua sem aviso na
 * Central, porque aviso é só para quem NÃO foi atendido.
 *
 * Arquivo próprio, e não um terceiro caso no irmão: `tests/invariants/**` é
 * congelado pelo pre-commit, e acrescentar cobertura não é motivo para abrir a
 * válvula. Fixtures próprias (sufixo ...0003) para não depender da ordem.
 *
 * SABOTAGEM: voltar a guarda da atividade em `handleCallEnded` para
 * `row.contact_id && !bloqueado` (cala a timeline de TODO bloqueado) = este
 * caso vermelho.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { despacharEventoWacalls } from "@/lib/wacalls/events-bridge";
import type { WacallsSessionMap } from "@/lib/wacalls/events-bridge";

import { GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

const SESSAO = "dddddddd-2222-4000-8000-000000000003";
const SESSAO_UPSTREAM = "wacalls-sessao-atendida-bloqueado";
const CONTATO = "dddddddd-3333-4000-8000-000000000003";
const CONVERSA = "dddddddd-4444-4000-8000-000000000003";
const NEGOCIO = "dddddddd-6666-4000-8000-000000000003";
const FONE = "5511977770003";
const CHAMADA = "bloq-atendida-1";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 2,
});

const logMudo = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof despacharEventoWacalls>[3];

function despachar(ev: Record<string, unknown>): Promise<void> {
  const cache = new Map<string, WacallsSessionMap>();
  return despacharEventoWacalls(pool, cache, JSON.stringify(ev), logMudo);
}

async function um<T extends pg.QueryResultRow>(texto: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await pool.query<T>(texto, params);
  return rows[0];
}

beforeAll(async () => {
  seedGov();
  sql(`
    insert into public.channel_sessions
      (id, organization_id, provider, wacalls_session_id, status, webhook_secret_encrypted)
      values ('${SESSAO}', '${GOV_ORG}', 'wacalls', '${SESSAO_UPSTREAM}', 'STARTING', '\\x00'::bytea)
      on conflict (id) do update set wacalls_session_id = excluded.wacalls_session_id,
                                     wacalls_paired_at = null, status = 'STARTING';
    insert into public.contacts (id, organization_id, display_name, phone_number, is_blocked)
      values ('${CONTATO}', '${GOV_ORG}', 'Bloqueado que foi atendido', '+${FONE}', true)
      on conflict (id) do update set phone_number = excluded.phone_number, is_blocked = true;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${SESSAO}', 'ai_handling')
      on conflict (id) do update set bot_silenced_until = null, last_handoff_reason = null;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, last_activity_at)
      values ('${NEGOCIO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${CONTATO}', 'Negocio do bloqueado atendido', 'open', now() - interval '30 days')
      on conflict (id) do update set last_activity_at = now() - interval '30 days';
    delete from public.voice_calls where organization_id = '${GOV_ORG}' and wacalls_call_id = '${CHAMADA}';
    delete from public.agent_inbox_items where organization_id = '${GOV_ORG}' and ref_id = '${CONTATO}';
    delete from public.crm_lead_activities where organization_id = '${GOV_ORG}' and contact_id = '${CONTATO}' and source_module = 'voice_calls';
  `);
  const linha = await um<{ n: string }>(
    `select count(*)::text as n from public.channel_sessions where id = $1`,
    [SESSAO],
  );
  if (linha?.n !== "1") {
    throw new Error(`o pool não vê a sessão semeada (porta ${PORTA})`);
  }
});

afterAll(async () => {
  await pool.end();
});

describe("WaCalls de bloqueado ATENDIDO: a conversa aconteceu e fica no histórico", () => {
  it("bloqueado atendido: linha encerrada e atendida, atividade na timeline, sem aviso", async () => {
    const base = {
      type: "call-status",
      sessionId: SESSAO_UPSTREAM,
      id: CHAMADA,
      peer: `${FONE}@s.whatsapp.net`,
      direction: "inbound",
      startedAt: Date.now(),
    };
    await despachar({ ...base, status: "ringing" });
    // `connected` é o que preenche `answered_at` (upsert de `handleCallStatus`).
    await despachar({ ...base, status: "connected" });
    await despachar({
      type: "call-ended",
      sessionId: SESSAO_UPSTREAM,
      id: CHAMADA,
      reason: "user_ended",
      endedAt: Date.now(),
    });

    const linha = await um<{ estado: string; atendida: boolean; contato: string | null }>(
      `select status as estado, answered_at is not null as atendida, contact_id::text as contato
         from public.voice_calls where organization_id = $1 and wacalls_call_id = $2`,
      [GOV_ORG, CHAMADA],
    );
    expect(linha?.estado).toBe("ended");
    expect(linha?.atendida).toBe(true);
    expect(linha?.contato).toBe(CONTATO);

    const aviso = await um<{ n: string }>(
      `select count(*)::text as n from public.agent_inbox_items
        where organization_id = $1 and kind = 'voice_call_missed' and ref_id = $2`,
      [GOV_ORG, CONTATO],
    );
    expect(aviso?.n).toBe("0");

    const atividade = await um<{ n: string }>(
      `select count(*)::text as n from public.crm_lead_activities
        where organization_id = $1 and contact_id = $2 and source_module = 'voice_calls'`,
      [GOV_ORG, CONTATO],
    );
    expect(Number(atividade?.n)).toBeGreaterThan(0);
  });
});
