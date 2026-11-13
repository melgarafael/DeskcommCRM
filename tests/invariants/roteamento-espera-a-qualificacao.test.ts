/**
 * #3966 — A CONVERSA PODE ESPERAR A IA QUALIFICAR: OPÇÃO DO NÚMERO, COM PRAZO.
 *
 * ─── O defeito, medido por @webtecnica no #4238 ─────────────────────────────
 *
 * A conversa nova pede roteamento no INSERT (`trg_conversation_routing_requested`)
 * e o worker a entregava em menos de 1 min. A atribuição grava
 * `assignee_kind='user'` e o gate cala a IA (`conversa_de_humano`): a fila
 * desligava o agente que deveria qualificar, e o lead ficava sem atendimento.
 *
 * ─── A forma que entrou (decisão do dono, doc 311, alternativa A) ───────────
 *
 * O mecanismo é o do #4238 — a passagem para humano (`last_handoff_at`) traz a
 * conversa de volta à fila UMA vez. Mas é OPÇÃO DO NÚMERO
 * (`channel_routing_policies.ai_wait_minutes`), DESLIGADA de fábrica, e tem
 * PRAZO: venceu sem a IA passar, a conversa entra na distribuição e a Central
 * avisa.
 *
 * ─── O que este arquivo prova, em Postgres real ─────────────────────────────
 *
 * DESLIGADA (o padrão) — igual à main, nos dois lados:
 *   1. com agente publicado no número, o worker distribui no NASCIMENTO;
 *   2. a passagem para humano NÃO emite pedido de roteamento.
 *
 * LIGADA:
 *   3. o worker não distribui e o pedido fica GUARDADO até o prazo (não morre
 *      consumido, não volta à varredura a cada minuto);
 *   4. a passagem para humano traz o MESMO pedido para agora, uma vez, e ele
 *      distribui; conversa com dono não pede nada;
 *   5. vencido o prazo sem passagem, a conversa é distribuída e a Central
 *      recebe UM aviso — que não se repete nas tentativas seguintes;
 *   6. o destino padrão do número não espera;
 *   7. a porta da opção recusa quem não é gestor, prazo fora da faixa e número
 *      sem regra própria.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { runRoutingWorker } from "@/lib/routing/worker";

import {
  GOV_AGENT_A as ana,
  GOV_CONV_UNASSIGNED as conv,
  GOV_MANAGER as manager,
  GOV_ORG as org,
  GOV_SESSION as channel,
  GOV_VIEWER as viewer,
  seedGov,
} from "./gov-helpers";
import { routingPgSupabase } from "../support/routing-pg-supabase";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const pedidos = async () =>
  (
    await query(
      `select status, next_attempt_at > now() + interval '30 minutes' as guardado, metadata
         from event_log
        where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'
        order by created_at`,
      [org, conv],
    )
  ).rows as Array<{ status: string; guardado: boolean | null; metadata: Record<string, unknown> | null }>;

const avisosDoPrazo = async () =>
  (
    await query(
      "select status, ref_kind from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='routing_ia_wait_expired'",
      [org, conv],
    )
  ).rows as Array<{ status: string; ref_kind: string }>;

/** O evento, por conversa: o `fn_wake_channel_routing` pode tocar outras. */
const limparPedidos = () =>
  query(
    "delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'",
    [org],
  );

/** Com sessão: a MESMA porta que a tela usa (`fn_set_channel_routing`). */
async function asUser(user: string, text: string, args: unknown[] = [], aal = "aal1") {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

const policyDoNumero = (users: string[], destinoPadrao: string | null = null) =>
  asUser(manager, "select fn_set_channel_routing($1,$2,$3,false,$4,$5) result", [
    org,
    channel,
    users,
    "round_robin",
    destinoPadrao,
  ]);

/** A MESMA porta que a tela usa para ligar/desligar a espera do número. */
const esperaDoNumero = (minutos: number | null, quem: string = manager) =>
  asUser(quem, "select fn_set_channel_ai_wait($1,$2,$3) result", [org, channel, minutos]);

/** Simula o UPDATE único de `performHumanHandoff`: status + marcador juntos. */
const passarParaHumano = () =>
  query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = 'infinity',
            last_handoff_at = now()
      where organization_id = $1 and id = $2`,
    [org, conv],
  );

const donoDaConversa = async () =>
  (
    (await query("select assigned_to_user_id from conversations where organization_id=$1 and id=$2", [org, conv]))
      .rows[0] as { assigned_to_user_id: string | null }
  ).assigned_to_user_id;

/**
 * `daquiA` adianta o relógio do worker. O padrão são 5 s de folga: o pedido
 * trazido para "agora" recebe o `now()` do BANCO, e um relógio do teste um
 * instante atrás dele deixaria o pedido fora da varredura sem motivo.
 */
const rodarWorker = async (daquiAMs = 5_000) => {
  const adapter = routingPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
  const result = await runRoutingWorker({ now: new Date(Date.now() + daquiAMs) });
  expect(adapter.errors).toEqual([]);
  return result;
};
const MINUTO = 60_000;

/** O agente de qualificação publicado NESTE número (a régua do motor). */
const publicarAgente = async () => {
  const agente = await query(
    `insert into ai_agents (organization_id, name, system_prompt, kind)
     values ($1, 'Qualificação', 'Qualifique o lead.', 'rag_bot')
     returning id`,
    [org],
  );
  const versao = await query(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, published_at)
     values ($1, $2, 1, 'Qualifique o lead.', 'anthropic', 'claude-sonnet-4-6', $3, 'published', now())
     returning id`,
    [org, (agente.rows[0] as { id: string }).id, channel],
  );
  const versaoId = (versao.rows[0] as { id: string }).id;
  await query("update ai_agents set published_version_id = $1 where id = $2", [
    versaoId,
    (agente.rows[0] as { id: string }).id,
  ]);
  return versaoId;
};

beforeAll(() => seedGov());
afterAll(() => pool.end());

beforeEach(async () => {
  await query("delete from ai_agents where organization_id=$1", [org]);
  await query("delete from ai_agent_versions where organization_id=$1", [org]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
  await policyDoNumero([ana]);
  await query(
    `insert into attendant_availability (organization_id, user_id, is_available, capacity, schedule)
     values ($1, $2, true, 1, '{}')
     on conflict (organization_id, user_id) do update set is_available = true, capacity = 1, schedule = '{}'`,
    [org, ana],
  );
  await query(
    `update user_organizations set revoked_at = null, role = 'agent' where organization_id = $1 and user_id = $2`,
    [org, ana],
  );
  await query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{routing}', '{"mode":"round_robin","max_retries":3,"backoff_seconds":1}')
      where id = $1`,
    [org],
  );
  await query(
    `update conversations
        set assigned_to_user_id = null, assigned_to_user_name = null, assigned_at = null,
            assignee_kind = null, status = 'open', last_handoff_at = null, bot_silenced_until = null
      where organization_id = $1 and id = $2`,
    [org, conv],
  );
  await query("delete from agent_inbox_items where organization_id=$1 and kind='routing_ia_wait_expired'", [org]);
  await limparPedidos();
});

describe("#3966 — opção DESLIGADA (o padrão de fábrica): igual à main", () => {
  it("a regra do número nasce com a espera desligada", async () => {
    const regra = await query(
      "select ai_wait_minutes from channel_routing_policies where organization_id=$1 and channel_session_id=$2",
      [org, channel],
    );
    expect(regra.rows).toEqual([{ ai_wait_minutes: null }]);
  });

  it("⭐ com agente publicado no número, o worker distribui no NASCIMENTO", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await pedidos()).length).toBe(1);

    const result = await rodarWorker();
    expect(result.outcomes.waiting_ia_qualificando, JSON.stringify(result)).toBe(0);
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa()).toBe(ana);
    expect(await avisosDoPrazo()).toEqual([]);
  });

  it("⭐ a passagem para humano NÃO emite pedido de roteamento", async () => {
    await publicarAgente();
    await passarParaHumano();
    expect(await pedidos()).toHaveLength(0);
  });

  it("sem agente nenhum, distribui no nascimento (compatibilidade)", async () => {
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    const result = await rodarWorker();
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa()).toBe(ana);
  });
});

describe("#3966 — opção LIGADA no número: espera a IA, com prazo", () => {
  beforeEach(async () => {
    await esperaDoNumero(60);
    // Ligar a opção acorda as conversas sem dono do número; o cenário começa limpo.
    await limparPedidos();
  });

  it("sem agente de IA no número, a opção ligada não atrasa ninguém", async () => {
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    const result = await rodarWorker();
    expect(result.outcomes.waiting_ia_qualificando, JSON.stringify(result)).toBe(0);
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
  });

  it("com agente publicado e sem passagem, NADA é distribuído e o pedido fica guardado até o prazo", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);

    const result = await rodarWorker();
    expect(result.outcomes.waiting_ia_qualificando, JSON.stringify(result)).toBe(1);
    expect(result.outcomes.assigned).toBe(0);
    expect(await donoDaConversa()).toBeNull();

    // O pedido NÃO morreu: segue pendente, agendado para o prazo. É o que
    // garante a volta à fila mesmo se a IA nunca passar a conversa.
    const guardados = await pedidos();
    expect(guardados.map((p) => [p.status, p.guardado])).toEqual([["pending", true]]);

    // E não volta à varredura a cada minuto: a rodada seguinte não o vê.
    const segunda = await rodarWorker();
    expect(segunda.batch_size, JSON.stringify(segunda)).toBe(0);
    expect(await avisosDoPrazo()).toEqual([]);
  });

  it("a passagem para humano traz o MESMO pedido para agora, uma vez, e ele distribui", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await rodarWorker()).outcomes.waiting_ia_qualificando).toBe(1);

    // A IA passa para humano: status + last_handoff_at no MESMO update.
    await passarParaHumano();
    const depois = await pedidos();
    expect(depois.map((p) => [p.status, p.guardado])).toEqual([["pending", false]]);

    // Repetir a passagem não abre outro pedido (o índice parcial deduplica).
    await passarParaHumano();
    expect(await pedidos()).toHaveLength(1);

    const result = await rodarWorker();
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa(), JSON.stringify(result)).toBe(ana);
    expect((await pedidos()).filter((p) => p.status === "pending")).toHaveLength(0);
    // Passou dentro do prazo: nada a avisar.
    expect(await avisosDoPrazo()).toEqual([]);
  });

  it("conversa COM dono não pede roteamento na passagem — quem manda é o dono", async () => {
    await query(
      "update conversations set assigned_to_user_id=$1, assignee_kind='user', status='claimed' where organization_id=$2 and id=$3",
      [ana, org, conv],
    );
    await passarParaHumano();
    expect(await pedidos()).toHaveLength(0);
  });

  it("⭐ venceu o prazo sem a IA passar: a conversa é distribuída e a Central avisa", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await rodarWorker()).outcomes.waiting_ia_qualificando).toBe(1);

    // 59 minutos depois ainda é espera: o pedido nem entra na varredura.
    expect((await rodarWorker(59 * MINUTO)).batch_size).toBe(0);

    const result = await rodarWorker(61 * MINUTO);
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa()).toBe(ana);
    expect(await avisosDoPrazo()).toEqual([{ status: "open", ref_kind: "conversation" }]);
  });

  it("o aviso do prazo sai UMA vez, mesmo com a conversa girando sem elegível", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await rodarWorker()).outcomes.waiting_ia_qualificando).toBe(1);
    await query(
      "update attendant_availability set is_available = false where organization_id = $1 and user_id = $2",
      [org, ana],
    );
    // A indisponibilidade acorda o número; o pedido volta a esperar pelo MESMO prazo.
    expect((await rodarWorker()).outcomes.assigned).toBe(0);

    // `>= 1`: a indisponibilidade acorda TODA conversa sem dono da organização,
    // e as vizinhas do fixture também giram sem elegível nesta rodada.
    const primeira = await rodarWorker(61 * MINUTO);
    expect(primeira.outcomes.requeued_no_eligible, JSON.stringify(primeira)).toBeGreaterThanOrEqual(1);
    expect(primeira.outcomes.assigned, JSON.stringify(primeira)).toBe(0);
    expect(await donoDaConversa()).toBeNull();
    expect(await avisosDoPrazo()).toHaveLength(1);

    const segunda = await rodarWorker(120 * MINUTO);
    expect(segunda.outcomes.requeued_no_eligible, JSON.stringify(segunda)).toBeGreaterThanOrEqual(1);
    expect(await donoDaConversa()).toBeNull();
    expect(await avisosDoPrazo()).toHaveLength(1);
    // A marca que impede a repetição mora no próprio pedido.
    expect((await pedidos()).map((p) => (p.metadata?.espera_pela_ia as { avisada?: boolean })?.avisada)).toEqual([true]);
  });

  it("⭐ o destino padrão do número não espera: entrega direto, como na main (#2331)", async () => {
    await policyDoNumero([ana], ana);
    await limparPedidos();
    await publicarAgente();
    // Regravar os responsáveis não desliga a espera do número.
    expect(
      (
        await query(
          "select ai_wait_minutes from channel_routing_policies where organization_id=$1 and channel_session_id=$2",
          [org, channel],
        )
      ).rows,
    ).toEqual([{ ai_wait_minutes: 60 }]);
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);

    const result = await rodarWorker();
    expect(result.outcomes.waiting_ia_qualificando, JSON.stringify(result)).toBe(0);
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa()).toBe(ana);
  });

  it("desligar a opção devolve à fila quem estava esperando", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await rodarWorker()).outcomes.waiting_ia_qualificando).toBe(1);

    await esperaDoNumero(null);
    const result = await rodarWorker();
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa()).toBe(ana);
  });
});

describe("#3966 — a porta da opção (fn_set_channel_ai_wait)", () => {
  it("quem não é gestor não liga a espera", async () => {
    await expect(esperaDoNumero(60, viewer)).rejects.toThrow("routing_forbidden");
    await expect(esperaDoNumero(60, ana)).rejects.toThrow("routing_forbidden");
  });

  it("prazo fora da faixa é recusado sem gravar", async () => {
    await expect(esperaDoNumero(14)).rejects.toThrow("routing_invalid_ai_wait");
    await expect(esperaDoNumero(10081)).rejects.toThrow("routing_invalid_ai_wait");
    expect(
      (
        await query(
          "select ai_wait_minutes from channel_routing_policies where organization_id=$1 and channel_session_id=$2",
          [org, channel],
        )
      ).rows,
    ).toEqual([{ ai_wait_minutes: null }]);
  });

  it("número sem regra própria não ganha regra por esta porta", async () => {
    await query("delete from channel_routing_policies where organization_id=$1", [org]);
    await expect(esperaDoNumero(60)).rejects.toThrow("routing_channel_not_found");
    expect(
      (await query("select count(*)::int n from channel_routing_policies where organization_id=$1", [org])).rows,
    ).toEqual([{ n: 0 }]);
  });
});
