import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  CORPO_DO_GO_LIVE,
  TITULO_DO_GO_LIVE,
  channelHealthTick,
} from "@/lib/agent-engine/health/circuit";
import { enforceHolds } from "@/lib/agent-engine/edge/crm/session-watchdog";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { warmupCapFor } from "@/lib/agent-engine/pacing/engine";
import { parseWarmupCaps } from "@/lib/agent-engine/pacing/store";
import { WARMUP_PULADO } from "@/lib/ai/pacing-knobs";

/**
 * A trava de número novo sai sozinha, na atualização, do número que já está
 * formado (migration 0574, PR #2327, doc 109 opção A) — e de nenhum outro.
 *
 * Invariante porque a regra é SQL (`fn_go_live_solta_numero_formado`, no
 * `baseline.sql` que o kit aplica) e porque o que ela promete é ser a MESMA
 * régua do controle de ritmo, escrita em TypeScript: a tabela de degraus
 * abaixo usa as funções do motor como oráculo.
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

const ORG = "0be7a70a-2574-4000-8000-000000000001";
const ORG_B = "0be7a70a-2574-4000-8000-000000000002";
const id = (n: number): string => `0be7a70a-2574-4000-8000-${String(n).padStart(12, "0")}`;

let seq = 100;

/** Um número com a linha de saúde, o item da Central e, se pedido, a linha de ritmo. */
async function numero(opts: {
  org?: string;
  trava?: "go_live" | "block_rate";
  /** idade declarada em `channel_knobs.number_activated_at`; omitido = sem linha de ritmo */
  dias?: number;
  degraus?: unknown;
  /** mensagens: [direção, situação, dias atrás] */
  mensagens?: Array<["inbound" | "outbound", string, number]>;
}): Promise<string> {
  const org = opts.org ?? ORG;
  const sessao = id((seq += 1));
  const contato = id((seq += 1));
  const conversa = id((seq += 1));
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
     values ($1, $2, $3, '\\x00'::bytea, 'WORKING')`,
    [sessao, org, `sessao-0574-${seq}`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Lead 0574', $3)`,
    [contato, org, `+55119000${String(seq).padStart(5, "0")}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4)`,
    [conversa, org, contato, sessao],
  );
  const trava = opts.trava ?? "go_live";
  await pool.query(
    `insert into channel_session_health
       (organization_id, channel_session_id, status, health_hold_active, health_hold_reason, health_held_at, health_released_at)
     values ($1, $2, 'WORKING', true, $3, now(), case when $3 = 'go_live' then null else now() - interval '60 days' end)`,
    [org, sessao, trava],
  );
  await pool.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
     values ($1, 'other', 'info', 'item do número', 'number_health', $2)`,
    [org, sessao],
  );
  if (opts.dias !== undefined) {
    await pool.query(
      `insert into channel_knobs (organization_id, channel_session_id, number_activated_at, warmup_daily_caps)
       values ($1, $2, now() - make_interval(days => $3) - interval '1 hour', $4::jsonb)`,
      [org, sessao, opts.dias, opts.degraus === undefined ? null : JSON.stringify(opts.degraus)],
    );
  }
  for (const [direcao, situacao, diasAtras] of opts.mensagens ?? []) {
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_at)
       values ($1, $2, $3, $4, 'text', $5, $6, 'oi', now() - make_interval(days => $7))`,
      [org, conversa, sessao, contato, direcao, situacao, diasAtras],
    );
  }
  return sessao;
}

async function estado(sessao: string, org = ORG) {
  const { rows } = await pool.query<{
    travado: boolean;
    razao: string | null;
    liberado: boolean;
    item: string;
    auditoria: Array<{ motivo: string; itens_fechados: number }>;
  }>(
    `select h.health_hold_active as travado, h.health_hold_reason as razao,
            h.health_released_at is not null as liberado,
            (select i.status from agent_inbox_items i
              where i.organization_id = h.organization_id and i.ref_id = h.channel_session_id) as item,
            (select coalesce(jsonb_agg(a.metadata), '[]'::jsonb) from api_audit_log a
              where a.organization_id = h.organization_id and a.resource_id = h.channel_session_id
                and a.action = 'channel.go_live_liberado_na_atualizacao') as auditoria
     from channel_session_health h
     where h.organization_id = $1 and h.channel_session_id = $2`,
    [org, sessao],
  );
  return rows[0]!;
}

const soltar = async (): Promise<number> =>
  (await pool.query<{ n: number }>("select public.fn_go_live_solta_numero_formado() as n")).rows[0]!.n;

/** Degraus × idade, com a resposta que o MOTOR dá: sem limite de aquecimento? */
const REGUA: Array<{ nome: string; degraus?: unknown; dias: number }> = [
  { nome: "padrão, 30 dias", dias: 30 },
  { nome: "padrão, 31 dias", dias: 31 },
  { nome: "pular o aquecimento, dia 0", degraus: WARMUP_PULADO, dias: 0 },
  { nome: "degraus próprios, antes do 'sem limite'", degraus: [{ minAgeDays: 0, cap: 10 }, { minAgeDays: 10, cap: null }], dias: 9 },
  { nome: "degraus próprios, no 'sem limite'", degraus: [{ minAgeDays: 0, cap: 10 }, { minAgeDays: 10, cap: null }], dias: 10 },
  { nome: "fora de ordem: vale o último alcançado", degraus: [{ minAgeDays: 10, cap: null }, { minAgeDays: 0, cap: 10 }], dias: 20 },
  { nome: "aquém do primeiro degrau: vale o primeiro", degraus: [{ minAgeDays: 5, cap: null }], dias: 2 },
  { nome: "degrau inválido cai no padrão", degraus: [{ minAgeDays: "x", cap: 1 }], dias: 40 },
  { nome: "data no futuro conta como idade 0", dias: -5 },
];

const sessoes: Record<string, string> = {};

beforeAll(async () => {
  for (const org of [ORG, ORG_B]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Org 0574 LTDA', 'Org 0574')`,
      [org, `org-0574-${org.slice(-1)}`],
    );
  }
  sessoes.idade = await numero({ dias: 40 });
  sessoes.pulado = await numero({ dias: 0, degraus: WARMUP_PULADO });
  sessoes.saida = await numero({ mensagens: [["outbound", "delivered", 40], ["outbound", "sent", 1]] });
  sessoes.novo = await numero({ dias: 3, mensagens: [["outbound", "read", 2]] });
  sessoes.soEntrada = await numero({ mensagens: [["inbound", "received", 40], ["outbound", "failed", 40]] });
  sessoes.saude = await numero({ trava: "block_rate", dias: 40 });
  sessoes.vizinho = await numero({ org: ORG_B });
  // O item da org vizinha que aponta para o MESMO número: só a organização dona casa.
  await pool.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
     values ($1, 'other', 'info', 'item de outra org', 'number_health', $2)`,
    [ORG_B, sessoes.idade],
  );
  for (const caso of REGUA) {
    sessoes[caso.nome] = await numero({ dias: caso.dias, degraus: caso.degraus });
  }
});

afterAll(async () => {
  await pool.end();
});

describe("a transição da atualização (fn_go_live_solta_numero_formado)", () => {
  let soltos = 0;

  beforeAll(async () => {
    soltos = await soltar();
  });

  it("o baseline aplicado em install E update rodou a transição UMA vez", async () => {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from api_audit_log where action = 'channel.go_live_transicao_da_atualizacao'",
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("número formado pelo ritmo sai: trava solta, item fechado, registro com o motivo", async () => {
    for (const nome of ["idade", "pulado"]) {
      expect(await estado(sessoes[nome]!)).toEqual({
        travado: false,
        razao: null,
        liberado: true,
        item: "resolved",
        auditoria: [{ motivo: "ritmo_sem_limite_de_aquecimento", itens_fechados: 1 }],
      });
    }
  });

  it("número com saída real de 31 dias ou mais sai, mesmo sem a tela de ritmo", async () => {
    expect(await estado(sessoes.saida!)).toMatchObject({
      liberado: true,
      item: "resolved",
      auditoria: [{ motivo: "primeira_saida_ha_31_dias_ou_mais", itens_fechados: 1 }],
    });
  });

  it("número novo continua travado — e entrada ou saída que falhou não contam como idade", async () => {
    for (const nome of ["novo", "soEntrada"]) {
      expect(await estado(sessoes[nome]!)).toEqual({
        travado: true,
        razao: "go_live",
        liberado: false,
        item: "open",
        auditoria: [],
      });
    }
  });

  it("trava de saúde fica intocada, mesmo em número formado", async () => {
    expect(await estado(sessoes.saude!)).toMatchObject({
      travado: true,
      razao: "block_rate",
      item: "open",
      auditoria: [],
    });
  });

  it("a org vizinha fica intocada: o número dela e o item dela que aponta para o nosso", async () => {
    expect(await estado(sessoes.vizinho!, ORG_B)).toMatchObject({ travado: true, liberado: false, item: "open" });
    const { rows } = await pool.query<{ status: string }>(
      "select status from agent_inbox_items where organization_id = $1 and ref_id = $2",
      [ORG_B, sessoes.idade],
    );
    expect(rows.map((r) => r.status)).toEqual(["open"]);
  });

  it.each(REGUA)("mesma régua do motor: $nome", async (caso) => {
    const degraus = parseWarmupCaps(caso.degraus) ?? PACING_DEFAULTS.warmupDailyCaps;
    const formado = warmupCapFor(Math.max(0, caso.dias), degraus) === null;
    expect((await estado(sessoes[caso.nome]!)).liberado).toBe(formado);
  });

  it("devolve quantos soltou, e rodar de novo não muda nada", async () => {
    const formadosNaRegua = REGUA.filter(
      (c) => warmupCapFor(Math.max(0, c.dias), parseWarmupCaps(c.degraus) ?? PACING_DEFAULTS.warmupDailyCaps) === null,
    ).length;
    expect(soltos).toBe(3 + formadosNaRegua);

    const antes = await pool.query("select * from api_audit_log order by id");
    const saudeAntes = await pool.query("select * from channel_session_health order by id");
    expect(await soltar()).toBe(0);
    expect((await pool.query("select * from api_audit_log order by id")).rows).toEqual(antes.rows);
    expect((await pool.query("select * from channel_session_health order by id")).rows).toEqual(saudeAntes.rows);
  });
});

describe("o item da trava de número novo na Central (circuit.ts)", () => {
  it("nasce como aviso e diz que os retornos pararam; o item antigo de 'informação' é reescrito", async () => {
    // Número recém-chegado: linha de saúde ainda sem trava, como o tick a encontra.
    const fresco = id((seq += 1));
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
       values ($1, $2, 'sessao-0574-fresca', '\\x00'::bytea, 'WORKING')`,
      [fresco, ORG],
    );
    await pool.query(
      `insert into channel_session_health (organization_id, channel_session_id, status) values ($1, $2, 'WORKING')`,
      [ORG, fresco],
    );

    await channelHealthTick(pool);

    const { rows } = await pool.query<{ ref_id: string; severity: string; title: string; body: string }>(
      `select ref_id, severity, title, body from agent_inbox_items
        where organization_id = $1 and ref_id = any($2::uuid[]) and status = 'open'`,
      [ORG, [fresco, sessoes.novo]],
    );
    const esperado = { severity: "warn", title: TITULO_DO_GO_LIVE, body: CORPO_DO_GO_LIVE };
    expect(rows.find((r) => r.ref_id === fresco)).toMatchObject(esperado);
    expect(rows.find((r) => r.ref_id === sessoes.novo)).toMatchObject(esperado);
  });
});

describe("a liberação devolve os retornos retidos espaçados (session-watchdog.ts)", () => {
  it("um a cada 5 minutos ou mais, no mesmo número, em vez de todos no mesmo instante", async () => {
    const sessao = await numero({});
    const { rows: conv } = await pool.query<{ contact_id: string }>(
      "select contact_id from conversations where channel_session_id = $1",
      [sessao],
    );
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `insert into job_queue (organization_id, contact_id, kind, payload, status, run_after)
         values ($1, $2, 'followup_turn', jsonb_build_object('channel_session_id', $3::text), 'pending', now() - interval '1 hour')`,
        [ORG, conv[0]!.contact_id, sessao],
      );
    }
    expect((await enforceHolds(pool)).held).toBe(3);

    await pool.query(
      `update channel_session_health set health_hold_active = false, health_hold_reason = null
        where channel_session_id = $1`,
      [sessao],
    );
    expect((await enforceHolds(pool)).released).toBe(3);
    const { rows } = await pool.query<{ run_after: Date }>(
      "select run_after from job_queue where payload->>'channel_session_id' = $1 order by run_after",
      [sessao],
    );
    const intervalos = rows.slice(1).map((r, i) => r.run_after.getTime() - rows[i]!.run_after.getTime());
    expect(intervalos).toHaveLength(2);
    for (const ms of intervalos) expect(ms).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
