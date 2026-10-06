import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { channelHealthTick } from "@/lib/agent-engine/health/circuit";

/**
 * A transição da 0574 alcança também o número SEM linha de saúde.
 *
 * A linha de `channel_session_health` só nasce no primeiro aviso de conexão
 * (`gravarEpisodio`, em `lib/channels/health.ts`). Sem ela o número não está
 * travado — mas, no primeiro aviso depois da atualização, a linha nasce com
 * `health_released_at` nulo e o tick a trava como "número novo". Como a
 * transição roda uma vez só, um número que opera há meses ficaria com os
 * retornos parados até alguém liberar na Central — o que a opção A do doc 109
 * escolheu evitar.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "0be7a70b-2574-4000-8000-000000000001";
const id = (n: number): string => `0be7a70b-2574-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 100;

/** Um número SEM linha de saúde: só a sessão, e o que se pedir de ritmo e mensagens. */
async function numeroSemLinha(opts: { dias?: number; saidaHaDias?: number }): Promise<string> {
  const sessao = id((seq += 1));
  const contato = id((seq += 1));
  const conversa = id((seq += 1));
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
     values ($1, $2, $3, '\\x00'::bytea, 'WORKING')`,
    [sessao, ORG, `sessao-sem-linha-${seq}`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Lead', $3)`,
    [contato, ORG, `+55119100${String(seq).padStart(5, "0")}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4)`,
    [conversa, ORG, contato, sessao],
  );
  if (opts.dias !== undefined) {
    await pool.query(
      `insert into channel_knobs (organization_id, channel_session_id, number_activated_at)
       values ($1, $2, now() - make_interval(days => $3) - interval '1 hour')`,
      [ORG, sessao, opts.dias],
    );
  }
  if (opts.saidaHaDias !== undefined) {
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_at)
       values ($1, $2, $3, $4, 'text', 'outbound', 'delivered', 'oi', now() - make_interval(days => $5))`,
      [ORG, conversa, sessao, contato, opts.saidaHaDias],
    );
  }
  return sessao;
}

/** O que `gravarEpisodio` faz no primeiro aviso de conexão: upsert pelo par, sem tocar na trava. */
async function primeiroAvisoDeConexao(sessao: string): Promise<void> {
  await pool.query(
    `insert into channel_session_health (organization_id, channel_session_id, status, escalated_status)
     values ($1, $2, 'SCAN_QR_CODE', 'SCAN_QR_CODE')
     on conflict (organization_id, channel_session_id)
       do update set status = excluded.status, escalated_status = excluded.escalated_status, updated_at = now()`,
    [ORG, sessao],
  );
}

async function saude(sessao: string) {
  const { rows } = await pool.query<{ travado: boolean; razao: string | null; liberado: boolean }>(
    `select health_hold_active as travado, health_hold_reason as razao, health_released_at is not null as liberado
       from channel_session_health where organization_id = $1 and channel_session_id = $2`,
    [ORG, sessao],
  );
  return rows[0] ?? null;
}

const sessoes: Record<string, string> = {};
let soltos = 0;

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'org-sem-linha', 'Org LTDA', 'Org')`,
    [ORG],
  );
  sessoes.peloRitmo = await numeroSemLinha({ dias: 40 });
  sessoes.pelaSaida = await numeroSemLinha({ saidaHaDias: 40 });
  sessoes.novo = await numeroSemLinha({ dias: 3, saidaHaDias: 2 });
  soltos = (await pool.query<{ n: number }>("select public.fn_go_live_solta_numero_formado() as n")).rows[0]!.n;
});

afterAll(async () => {
  await pool.end();
});

describe("número sem linha de saúde na atualização", () => {
  it("o formado ganha a linha já liberada, com o registro do motivo", async () => {
    expect(soltos).toBe(2);
    expect(await saude(sessoes.peloRitmo!)).toEqual({ travado: false, razao: null, liberado: true });
    expect(await saude(sessoes.pelaSaida!)).toEqual({ travado: false, razao: null, liberado: true });
    const { rows } = await pool.query<{ resource_id: string; motivo: string }>(
      `select resource_id, metadata->>'motivo' as motivo from api_audit_log
        where action = 'channel.go_live_liberado_na_atualizacao' order by metadata->>'motivo'`,
    );
    expect(rows).toEqual([
      { resource_id: sessoes.pelaSaida, motivo: "primeira_saida_ha_31_dias_ou_mais" },
      { resource_id: sessoes.peloRitmo, motivo: "ritmo_sem_limite_de_aquecimento" },
    ]);
  });

  it("o novo não ganha linha nenhuma — muito menos uma liberada", async () => {
    expect(await saude(sessoes.novo!)).toBeNull();
  });

  it("no primeiro aviso de conexão, o formado segue liberado e só o novo é travado", async () => {
    for (const s of Object.values(sessoes)) await primeiroAvisoDeConexao(s);
    await channelHealthTick(pool);
    expect(await saude(sessoes.peloRitmo!)).toMatchObject({ travado: false, liberado: true });
    expect(await saude(sessoes.pelaSaida!)).toMatchObject({ travado: false, liberado: true });
    expect(await saude(sessoes.novo!)).toEqual({ travado: true, razao: "go_live", liberado: false });
  });

  it("rodar de novo não solta mais nada", async () => {
    expect((await pool.query<{ n: number }>("select public.fn_go_live_solta_numero_formado() as n")).rows[0]!.n).toBe(0);
  });
});
