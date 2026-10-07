/**
 * PONTE WACALLS: chamada perdida de contato PESSOAL (spec 21) não abre aviso
 * na Central nem carimba a timeline — a linha continua gravada.
 *
 * Irmão de `voz-recusa-bloqueado.test.ts` (que tem o controle do contato
 * normal, provando que o mesmo caminho ABRE aviso e carimba): a função REAL
 * (`despacharEventoWacalls`) contra o Postgres efêmero, lendo o estado que
 * sobrou.
 *
 * SABOTAGEM: voltar a consulta de `contatoEstaBloqueado` para
 * `select is_blocked` (sem `or is_personal`) = este caso vermelho.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { despacharEventoWacalls } from "@/lib/wacalls/events-bridge";
import type { WacallsSessionMap } from "@/lib/wacalls/events-bridge";

import { GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

const SESSAO = "dddddddd-2222-4000-8000-000000000011";
const SESSAO_UPSTREAM = "wacalls-sessao-recusa-pessoal";
const CONTATO_PESSOAL = "dddddddd-3333-4000-8000-000000000011";
const NEGOCIO_PESSOAL = "dddddddd-6666-4000-8000-000000000011";
const FONE_PESSOAL = "5511977770011";

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
    insert into public.contacts (id, organization_id, display_name, phone_number, is_blocked, is_personal)
      values ('${CONTATO_PESSOAL}', '${GOV_ORG}', 'Pessoal da Voz', '+${FONE_PESSOAL}', false, true)
      on conflict (id) do update set phone_number = excluded.phone_number, is_blocked = false, is_personal = true;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, last_activity_at)
      values ('${NEGOCIO_PESSOAL}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${CONTATO_PESSOAL}', 'Negocio do pessoal', 'open', now() - interval '30 days')
      on conflict (id) do update set last_activity_at = now() - interval '30 days';
    delete from public.voice_calls where organization_id = '${GOV_ORG}' and wacalls_call_id = 'pessoal-1';
    delete from public.agent_inbox_items where organization_id = '${GOV_ORG}' and ref_id = '${CONTATO_PESSOAL}';
    delete from public.crm_lead_activities where organization_id = '${GOV_ORG}' and contact_id = '${CONTATO_PESSOAL}' and source_module = 'voice_calls';
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

describe("WaCalls de contato pessoal: linha gravada, sem aviso, sem atividade", () => {
  it("a perdida existe, com o contato resolvido, mas não nasce aviso nem atividade", async () => {
    await chamadaPerdida("pessoal-1", FONE_PESSOAL);
    const linha = await um<{ estado: string; contato: string | null }>(
      `select status as estado, contact_id::text as contato from public.voice_calls
        where organization_id = $1 and wacalls_call_id = $2`,
      [GOV_ORG, "pessoal-1"],
    );
    expect(linha?.estado).toBe("ended");
    expect(linha?.contato).toBe(CONTATO_PESSOAL);
    const aviso = await um<{ n: string }>(
      `select count(*)::text as n from public.agent_inbox_items
        where organization_id = $1 and kind = 'voice_call_missed' and ref_id = $2`,
      [GOV_ORG, CONTATO_PESSOAL],
    );
    expect(aviso?.n).toBe("0");
    const atividade = await um<{ n: string }>(
      `select count(*)::text as n from public.crm_lead_activities
        where organization_id = $1 and contact_id = $2 and source_module = 'voice_calls'`,
      [GOV_ORG, CONTATO_PESSOAL],
    );
    expect(atividade?.n).toBe("0");
  });
});
