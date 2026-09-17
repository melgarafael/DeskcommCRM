/**
 * O SENTIDO INFERIDO NÃO REESCREVE A LIGAÇÃO QUE JÁ EXISTE — contra Postgres.
 *
 * A ponte infere o sentido de um `call-status` sem `direction` pelo dono
 * (`lib/wacalls/events-bridge.ts`): com dono, feita; sem dono, recebida. Isso
 * só pode valer no INSERT. Uma ligação RECEBIDA nasce sem dono, alguém a
 * atende pelo CRM, e o `call-status` seguinte chega COM dono e ainda sem
 * `direction` — se o conflito aceitasse o inferido, toda recebida atendida
 * pelo CRM viraria "feita": o histórico mentiria o sentido, e a que terminasse
 * sem `connected` depois de ganhar dono deixaria de abrir "Chamada perdida".
 *
 * `voz-sentido-da-ligacao.test.ts` não prendia esta regra: trocar o `case`
 * do conflito por `direction = excluded.direction` passava em tudo. Arquivo
 * próprio porque aquele já está congelado pelo pre-commit.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { despacharEventoWacalls } from "@/lib/wacalls/events-bridge";
import type { WacallsSessionMap } from "@/lib/wacalls/events-bridge";

import { GOV_AGENT_A, GOV_ORG, seedGov, sql } from "./gov-helpers";

const VOZ_SESSAO = "cccccccc-2222-4000-8000-0000000000e1";
const SESSAO_UPSTREAM = "wacalls-sessao-do-inferido";
const PEER = "5511955550000@s.whatsapp.net";

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
  return despacharEventoWacalls(pool, new Map<string, WacallsSessionMap>(), JSON.stringify(ev), logMudo);
}

async function sentido(id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ direction: string }>(
    `select direction from public.voice_calls where organization_id = $1 and wacalls_call_id = $2`,
    [GOV_ORG, id],
  );
  return rows[0]?.direction;
}

beforeAll(async () => {
  seedGov();
  sql(`
    insert into public.channel_sessions
      (id, organization_id, provider, wacalls_session_id, status, webhook_secret_encrypted)
      values ('${VOZ_SESSAO}', '${GOV_ORG}', 'wacalls', '${SESSAO_UPSTREAM}', 'WORKING', '\\x00'::bytea)
      on conflict (id) do update set wacalls_session_id = excluded.wacalls_session_id;
  `);
  const { rows } = await pool.query(`select 1 from public.channel_sessions where id = $1`, [VOZ_SESSAO]);
  if (rows.length !== 1) throw new Error(`o pool não vê a sessão de voz semeada (porta ${PORTA})`);
});

afterAll(async () => {
  await pool.end();
});

describe("o sentido inferido vale só no INSERT", () => {
  it("recebida atendida pelo CRM continua recebida quando o evento seguinte chega com dono", async () => {
    const ID = "inferido-recebida-atendida";
    await despachar({ type: "call-status", sessionId: SESSAO_UPSTREAM, id: ID, status: "ringing", peer: PEER, startedAt: Date.now(), owner: null });
    expect(await sentido(ID)).toBe("inbound");

    await despachar({ type: "call-status", sessionId: SESSAO_UPSTREAM, id: ID, status: "connected", peer: PEER, startedAt: Date.now(), owner: GOV_AGENT_A });
    expect(await sentido(ID), "o dono do atendimento virou a recebida em feita").toBe("inbound");
  });

  it("controle: a feita continua feita quando um evento seguinte chega sem dono", async () => {
    const ID = "inferido-feita-sem-dono-depois";
    await despachar({ type: "call-status", sessionId: SESSAO_UPSTREAM, id: ID, status: "ringing", peer: PEER, startedAt: Date.now(), owner: GOV_AGENT_A });
    expect(await sentido(ID)).toBe("outbound");
    await despachar({ type: "call-status", sessionId: SESSAO_UPSTREAM, id: ID, status: "connected", peer: PEER, startedAt: Date.now() });
    expect(await sentido(ID)).toBe("outbound");
  });
});
