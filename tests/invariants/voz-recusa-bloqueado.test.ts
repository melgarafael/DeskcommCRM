/**
 * PONTE WACALLS: chamada de bloqueado não abre aviso nem carimba
 * a timeline (a linha continua gravada).
 *
 * Mesmo padrão de `voz-ponte-de-eventos.test.ts`: a função REAL
 * (`despacharEventoWacalls`) contra o Postgres efêmero, lendo o ESTADO que
 * sobrou — dublê de `pg.Pool` mediria texto de consulta, não desfecho.
 *
 * SABOTAGEM (prova no CI, via `pnpm test:db`): emitir o aviso ou a atividade
 * para bloqueado (remover qualquer um dos dois `&& !bloqueado` em
 * `handleCallEnded`) = caso "bloqueado" vermelho (1 caso cai); o controle
 * "não bloqueado" segue verde.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { despacharEventoWacalls } from "@/lib/wacalls/events-bridge";
import type { WacallsSessionMap } from "@/lib/wacalls/events-bridge";

import { GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

const SESSAO = "dddddddd-2222-4000-8000-000000000001";
const SESSAO_UPSTREAM = "wacalls-sessao-recusa-bloqueado";
const CONTATO_BLOQ = "dddddddd-3333-4000-8000-000000000001";
const CONTATO_OK = "dddddddd-3333-4000-8000-000000000002";
const CONVERSA_BLOQ = "dddddddd-4444-4000-8000-000000000001";
const CONVERSA_OK = "dddddddd-4444-4000-8000-000000000002";
const NEGOCIO_BLOQ = "dddddddd-6666-4000-8000-000000000001";
const NEGOCIO_OK = "dddddddd-6666-4000-8000-000000000002";
const FONE_BLOQ = "5511977770001";
const FONE_OK = "5511977770002";

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

/** Chamada recebida que ninguém atendeu (perdida), de ponta a ponta. */
async function chamadaPerdida(chamada: string, fone: string): Promise<void> {
  await despachar({
    type: "call-status",
    sessionId: SESSAO_UPSTREAM,
    id: chamada,
    status: "ringing",
    peer: `${fone}@s.whatsapp.net`,
    direction: "inbound",
    startedAt: Date.now(),
  });
  await despachar({
    type: "call-ended",
    sessionId: SESSAO_UPSTREAM,
    id: chamada,
    reason: "user_ended",
    endedAt: Date.now(),
  });
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
      values ('${CONTATO_BLOQ}', '${GOV_ORG}', 'Bloqueado da Voz', '+${FONE_BLOQ}', true)
      on conflict (id) do update set phone_number = excluded.phone_number, is_blocked = true;
    insert into public.contacts (id, organization_id, display_name, phone_number, is_blocked)
      values ('${CONTATO_OK}', '${GOV_ORG}', 'Controle da Voz', '+${FONE_OK}', false)
      on conflict (id) do update set phone_number = excluded.phone_number, is_blocked = false;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA_BLOQ}', '${GOV_ORG}', '${CONTATO_BLOQ}', '${SESSAO}', 'ai_handling')
      on conflict (id) do update set bot_silenced_until = null, last_handoff_reason = null;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA_OK}', '${GOV_ORG}', '${CONTATO_OK}', '${SESSAO}', 'ai_handling')
      on conflict (id) do update set bot_silenced_until = null, last_handoff_reason = null;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, last_activity_at)
      values ('${NEGOCIO_BLOQ}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${CONTATO_BLOQ}', 'Negocio do bloqueado', 'open', now() - interval '30 days')
      on conflict (id) do update set last_activity_at = now() - interval '30 days';
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, last_activity_at)
      values ('${NEGOCIO_OK}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${CONTATO_OK}', 'Negocio do controle', 'open', now() - interval '30 days')
      on conflict (id) do update set last_activity_at = now() - interval '30 days';
    delete from public.voice_calls where organization_id = '${GOV_ORG}' and wacalls_call_id in ('bloq-1', 'ok-1');
    delete from public.agent_inbox_items where organization_id = '${GOV_ORG}' and ref_id in ('${CONTATO_BLOQ}', '${CONTATO_OK}');
    delete from public.crm_lead_activities where organization_id = '${GOV_ORG}' and contact_id in ('${CONTATO_BLOQ}', '${CONTATO_OK}') and source_module = 'voice_calls';
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

describe("WaCalls de bloqueado: linha gravada, sem aviso, sem atividade", () => {
  it('controle — contato normal: perdida abre aviso e carimba a timeline (o instrumento funciona)', async () => {
    await chamadaPerdida("ok-1", FONE_OK);
    const linha = await um<{ estado: string }>(
      `select status as estado from public.voice_calls where organization_id = $1 and wacalls_call_id = $2`,
      [GOV_ORG, "ok-1"],
    );
    expect(linha?.estado).toBe("ended");
    const aviso = await um<{ n: string }>(
      `select count(*)::text as n from public.agent_inbox_items
        where organization_id = $1 and kind = 'voice_call_missed' and ref_id = $2`,
      [GOV_ORG, CONTATO_OK],
    );
    expect(Number(aviso?.n)).toBeGreaterThan(0);
    const atividade = await um<{ n: string }>(
      `select count(*)::text as n from public.crm_lead_activities
        where organization_id = $1 and contact_id = $2 and source_module = 'voice_calls'`,
      [GOV_ORG, CONTATO_OK],
    );
    expect(Number(atividade?.n)).toBeGreaterThan(0);
  });

  it('bloqueado: a linha existe, mas não nasce aviso nem atividade (recusada = não-interação)', async () => {
    await chamadaPerdida("bloq-1", FONE_BLOQ);
    const linha = await um<{ estado: string; contato: string | null }>(
      `select status as estado, contact_id::text as contato from public.voice_calls
        where organization_id = $1 and wacalls_call_id = $2`,
      [GOV_ORG, "bloq-1"],
    );
    // A linha continua gravada, com o contato resolvido.
    expect(linha?.estado).toBe("ended");
    expect(linha?.contato).toBe(CONTATO_BLOQ);
    const aviso = await um<{ n: string }>(
      `select count(*)::text as n from public.agent_inbox_items
        where organization_id = $1 and kind = 'voice_call_missed' and ref_id = $2`,
      [GOV_ORG, CONTATO_BLOQ],
    );
    expect(aviso?.n).toBe("0");
    const atividade = await um<{ n: string }>(
      `select count(*)::text as n from public.crm_lead_activities
        where organization_id = $1 and contact_id = $2 and source_module = 'voice_calls'`,
      [GOV_ORG, CONTATO_BLOQ],
    );
    expect(atividade?.n).toBe("0");
  });
});
