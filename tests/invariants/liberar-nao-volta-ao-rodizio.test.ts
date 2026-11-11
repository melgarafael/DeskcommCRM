/**
 * "LIBERAR" NÃO DEVOLVE A CONVERSA AO RODÍZIO (issue #3937, as duas portas).
 *
 * ## O defeito que este arquivo mata
 *
 * O gatilho `trg_routing_assignment_changed` (`supabase/baseline.sql`, função
 * `fn_routing_assignment_changed`) tratava dois fatos distintos como um só:
 *
 *   1. a conversa PERDE o dono — é o "Liberar" (`fn_conversation_assign` com
 *      `p_to_user_id` nulo e `reason='release'`), e
 *   2. a conversa REABRE, voltando de `closed`/`resolved`/`archived` para o pool.
 *
 * Nos dois casos ele chamava `fn_request_channel_routing`, então a conversa
 * liberada voltava a ter dono em ~1 minuto — o relato da issue mediu dezenas de
 * conversas liberadas com dono de novo em menos de 2 minutos. O item 1 da mesma
 * issue (contato do tipo Fornecedor fora da distribuição) já está na `main`
 * desde o #3942 e continua provado no arquivo irmão
 * `tests/invariants/rodizio-sem-fornecedor.test.ts`; este arquivo fecha a SEGUNDA
 * porta, e prova as duas juntas:
 *
 *   - a porta de ENTRADA recusa o fornecedor (caso 2, worker real);
 *   - a porta do BOTÃO "Liberar" não pede rodízio para ninguém — nem cliente,
 *     nem fornecedor (casos 1 e 2);
 *   - e a régua nova não desligou o acordar: reabertura (caso 3) e mudança de
 *     disponibilidade/capacidade (caso 4) continuam pedindo.
 *
 * ## Por que a prova é de BANCO
 *
 * O comportamento mora em duas funções de Postgres e num gatilho. Um teste de
 * unidade provaria que a função TS chamou a RPC — não que o UPDATE da conversa
 * deixou de emitir `conversation.routing_requested`. Aqui tudo roda contra o
 * Postgres efêmero do `pnpm test:db`, com gatilhos e RPCs reais, e o worker é o
 * de produção (`runRoutingWorker`) falando com o banco pela ponte
 * `tests/support/routing-pg-supabase.ts`.
 *
 * ## Relógio
 *
 * Nenhuma asserção depende de relógio real: as esperas são lidas do banco
 * (`next_attempt_at`) e o `now` do worker é injetado. O que se mede aqui é
 * "existe ou não existe pedido", que é binário e não depende de tempo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { runRoutingWorker } from "@/lib/routing/worker";
import { createAdminClient } from "@/lib/supabase/admin";

import { routingPgSupabase } from "../support/routing-pg-supabase";
import {
  GOV_AGENT_A as ana,
  GOV_MANAGER as manager,
  GOV_ORG as org,
  GOV_SESSION as channel,
  seedGov,
} from "./gov-helpers";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 5 });
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

/** RPC que exige papel de gestor: mesma sessão JWT que a rota usa (RLS real). */
async function asUser(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
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

const CONTATO_CLIENTE = "eeeeeeee-5555-4000-8000-000000000001";
const CONTATO_FORNECEDOR = "eeeeeeee-5555-4000-8000-000000000002";
const CONTATO_FECHADA = "eeeeeeee-5555-4000-8000-000000000003";
const CONTATO_ORFA = "eeeeeeee-5555-4000-8000-000000000004";
const CONV_CLIENTE = "eeeeeeee-6666-4000-8000-000000000001";
const CONV_FORNECEDOR = "eeeeeeee-6666-4000-8000-000000000002";
const CONV_FECHADA = "eeeeeeee-6666-4000-8000-000000000003";
const CONV_ORFA = "eeeeeeee-6666-4000-8000-000000000004";

const conversa = async (id: string) =>
  (
    await query(
      "select assigned_to_user_id, assignee_kind, status from conversations where organization_id=$1 and id=$2",
      [org, id],
    )
  ).rows[0] as { assigned_to_user_id: string | null; assignee_kind: string | null; status: string };

/** Quantos pedidos de rodízio existem para a conversa (qualquer status). */
const pedidos = async (id: string) =>
  Number(
    (
      await query(
        "select count(*)::int as n from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'",
        [org, id],
      )
    ).rows[0].n,
  );

const eventoDo = async (id: string) =>
  (
    await query(
      "select status, metadata from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested' order by created_at desc limit 1",
      [org, id],
    )
  ).rows[0] as { status: string; metadata: Record<string, unknown> } | undefined;

/** Roda o worker REAL contra o Postgres do harness; falha se a ponte engolir erro. */
async function rodarWorker() {
  const adapter = routingPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
  const resultado = await runRoutingWorker({ now: new Date() });
  expect(adapter.errors).toEqual([]);
  return resultado;
}

beforeAll(() => seedGov());
afterAll(() => pool.end());

beforeEach(async () => {
  // O mesmo ponto de partida do arquivo irmão: rodízio ligado, uma atendente
  // elegível e sem política por número — o único motivo de recusa possível é a
  // régua que este arquivo mede.
  await query("update user_organizations set revoked_at=null, role='agent' where organization_id=$1 and user_id=$2", [
    org,
    ana,
  ]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
  await query(
    `update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{routing}','{"mode":"round_robin"}')
      where id=$1`,
    [org],
  );
  await query(
    `insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule)
       values($1,$2,true,4,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=4,schedule='{}'`,
    [org, ana],
  );
  await asUser(manager, "select public.fn_set_channel_routing($1,$2,$3,false)", [org, channel, [ana]]);

  await query(
    // Um contato por conversa: `uniq_conversations_1to1_per_contact_session` é
    // um para um (contato, canal), e as quatro fixtures vivem no mesmo canal.
    `insert into public.contacts (id, organization_id, display_name, contact_type) values
       ($1,$5,'Liberar Cliente','cliente'),
       ($2,$5,'Liberar Fornecedor','fornecedor'),
       ($3,$5,'Liberar Fechada','cliente'),
       ($4,$5,'Liberar Orfa','cliente')
     on conflict (id) do update set contact_type=excluded.contact_type`,
    [CONTATO_CLIENTE, CONTATO_FORNECEDOR, CONTATO_FECHADA, CONTATO_ORFA, org],
  );

  // Duas conversas COM dono (o "Liberar" é sempre de quem tem dono), uma fechada
  // sem dono (para a reabertura) e uma aberta sem dono (para a disponibilidade).
  // As duas últimas nascem no pool e o INSERT emite por 0040 — a fila é zerada
  // logo abaixo, porque cada caso mede um pedido por vez.
  await query(
    `insert into public.conversations
       (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assignee_kind, assigned_at)
     values
       ($1,$5,$6,$10,'claimed',$11,'user',now()),
       ($2,$5,$7,$10,'claimed',$11,'user',now()),
       ($3,$5,$8,$10,'closed',null,null,null),
       ($4,$5,$9,$10,'open',null,null,null)
     on conflict (id) do update set contact_id=excluded.contact_id, status=excluded.status,
       assigned_to_user_id=excluded.assigned_to_user_id, assignee_kind=excluded.assignee_kind,
       assigned_at=excluded.assigned_at, metadata='{}'::jsonb`,
    [
      CONV_CLIENTE,
      CONV_FORNECEDOR,
      CONV_FECHADA,
      CONV_ORFA,
      org,
      CONTATO_CLIENTE,
      CONTATO_FORNECEDOR,
      CONTATO_FECHADA,
      CONTATO_ORFA,
      channel,
      ana,
    ],
  );

  await query("delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'", [org]);
});

describe("'Liberar' não devolve a conversa ao rodízio (#3937)", () => {
  it("cliente: liberar tira o dono e NÃO cria pedido; o worker não tem o que drenar", async () => {
    // Exatamente o que a rota faz: `fn_conversation_assign` com dono nulo e
    // `reason='release'` (release/route.ts:44-49).
    await query("select public.fn_conversation_assign($1,$2,null,'release')", [org, CONV_CLIENTE]);

    expect(await conversa(CONV_CLIENTE)).toMatchObject({
      assigned_to_user_id: null,
      assignee_kind: null,
      status: "open",
    });
    // A asserção do DEFEITO: no código antigo o gatilho pedia o rodízio na
    // MESMA transação e este número era 1.
    expect(await pedidos(CONV_CLIENTE)).toBe(0);

    const resultado = await rodarWorker();
    expect(resultado.batch_size).toBe(0);
    expect(resultado.outcomes.assigned).toBe(0);
    expect(resultado.outcomes.requeued_no_eligible).toBe(0);
  });

  it("fornecedor: a mesma porta não pede, e a porta de ENTRADA continua recusando", async () => {
    await query("select public.fn_conversation_assign($1,$2,null,'release')", [org, CONV_FORNECEDOR]);
    expect(await pedidos(CONV_FORNECEDOR)).toBe(0);

    // Segunda porta: alguém pede o rodízio para a conversa do fornecedor (é o
    // que a reabertura e a disponibilidade fazem). A distribuição recusa — o
    // conserto do "Liberar" não pode afrouxar a régua do tipo de contato.
    await query("select public.fn_request_channel_routing($1,$2)", [org, CONV_FORNECEDOR]);
    expect(await eventoDo(CONV_FORNECEDOR)).toMatchObject({ status: "pending" });

    const resultado = await rodarWorker();

    expect(resultado.outcomes.assigned).toBe(0);
    expect(resultado.outcomes.skipped_contato_fornecedor).toBe(1);
    expect(await conversa(CONV_FORNECEDOR)).toMatchObject({
      assigned_to_user_id: null,
      assignee_kind: null,
      status: "open",
    });
    // O evento fecha com motivo próprio: sem isso o pedido voltaria a cada tick.
    expect(await eventoDo(CONV_FORNECEDOR)).toMatchObject({ status: "done" });
  });

  it("reabertura continua pedindo rodízio — a régua nova não desligou a entrada", async () => {
    await query("update public.conversations set status='open' where organization_id=$1 and id=$2", [org, CONV_FECHADA]);

    const evento = await eventoDo(CONV_FECHADA);
    expect(evento).toMatchObject({ status: "pending" });
    expect(evento?.metadata).toBeTruthy();

    const resultado = await rodarWorker();
    expect(resultado.outcomes.assigned).toBe(1);
    expect(await conversa(CONV_FECHADA)).toMatchObject({ assigned_to_user_id: ana, status: "claimed" });
  });

  it("disponibilidade/capacidade da equipe continua acordando a conversa sem dono", async () => {
    expect(await pedidos(CONV_ORFA)).toBe(0);

    // Subir a capacidade é um dos gatilhos que a issue cita: ele NÃO passa pelo
    // gatilho da conversa, pede por `fn_wake_channel_routing`.
    await query("update attendant_availability set capacity=5 where organization_id=$1 and user_id=$2", [org, ana]);

    expect(await eventoDo(CONV_ORFA)).toMatchObject({ status: "pending" });
  });
});
