/**
 * RODÍZIO SEM FORNECEDOR (issue #3937) — invariante de banco, worker REAL.
 *
 * ## O defeito que este arquivo mata
 *
 * Agência de viagens com distribuição em **rodízio automático**: promoção de
 * operadora, comunicado de companhia aérea e recado de grupo comercial chegam
 * pelo mesmo número do cliente, são cadastrados como contato do tipo
 * `fornecedor` (`contacts.contact_type`, issue #3005) e **entravam no rodízio
 * como se fossem clientes** — ocupando carga e capacidade dos vendedores. O
 * único contato que o worker recusava era o `pessoal` (`lib/routing/worker.ts`,
 * `skipped_contato_pessoal`).
 *
 * ## Por que a prova é de BANCO e não de unidade pura
 *
 * A distribuição mora no banco em duas pontas: o gatilho
 * `trg_routing_assignment_changed` (`supabase/baseline.sql:23324`) reenfileira
 * a conversa sem dono, e quem dá o dono é a RPC `fn_channel_routing_claim`
 * (`supabase/baseline.sql:23404`), com carga, capacidade, jornada e fila. Um
 * dublê que devolve `{ data: [...] }` prova que o objeto foi lido — não que a
 * conversa ficou sem dono no Postgres de verdade. Aqui o `runRoutingWorker`
 * roda contra o Postgres efêmero do `pnpm test:db` (ponte
 * `tests/support/routing-pg-supabase.ts`), com as réguas, RPCs e gatilhos
 * reais.
 *
 * ## As três asserções que a fatia precisa
 *
 *   1. `fornecedor` NÃO recebe dono (e o evento fecha, não gira em backoff);
 *   2. `cliente` CONTINUA recebendo — a exclusão não pode virar "ninguém entra";
 *   3. `fornecedor` **e** `pessoal` juntos dão o resultado de HOJE
 *      (`skipped_contato_pessoal`): pessoal é a régua mais forte e a nova não
 *      pode divergir dela.
 *
 * O quarto caso media o caminho que o autor da issue descreve no defeito 2: o
 * `release` reenfileirava a conversa na MESMA transação, pelo gatilho, e a
 * distribuição a recusava de novo. Ele virou o CONTRATO com a migration 9332
 * (decisão do mantenedor: "Liberar" não pede rodízio): a conversa liberada não
 * gera pedido nenhum e continua sem dono. A régua do tipo de contato não mudou
 * — o caso 2 prova que ela segue recusando quem pedir a distribuição.
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

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
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

const FORNECEDOR = "dddddddd-3333-4000-8000-000000000001";
const CLIENTE = "dddddddd-3333-4000-8000-000000000002";
const FORNECEDOR_PESSOAL = "dddddddd-3333-4000-8000-000000000003";
const CONV_FORNECEDOR = "dddddddd-4444-4000-8000-000000000001";
const CONV_CLIENTE = "dddddddd-4444-4000-8000-000000000002";
const CONV_FORNECEDOR_PESSOAL = "dddddddd-4444-4000-8000-000000000003";

const conversa = async (id: string) =>
  (
    await query(
      "select assigned_to_user_id, assignee_kind, status from conversations where organization_id=$1 and id=$2",
      [org, id],
    )
  ).rows[0] as { assigned_to_user_id: string | null; assignee_kind: string | null; status: string };

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
  // Mesmo estado de partida do arquivo irmão (channel-routing.test.ts), para o
  // único motivo de recusa possível ser a régua do contato — e não elegibilidade.
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
    `insert into public.contacts (id, organization_id, display_name, contact_type, is_personal) values
       ($1,$4,'Rodizio Fornecedor','fornecedor',false),
       ($2,$4,'Rodizio Cliente','cliente',false),
       ($3,$4,'Rodizio Fornecedor Pessoal','fornecedor',true)
     on conflict (id) do update set contact_type=excluded.contact_type, is_personal=excluded.is_personal`,
    [FORNECEDOR, CLIENTE, FORNECEDOR_PESSOAL, org],
  );
  await query(
    `insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
       ($1,$4,$5,$7,'open'),
       ($2,$4,$6,$7,'open'),
       ($3,$4,$8,$7,'open')
     on conflict (id) do update set contact_id=excluded.contact_id, assigned_to_user_id=null,
       assigned_at=null, assignee_kind=null, status='open', metadata='{}'::jsonb`,
    [CONV_FORNECEDOR, CONV_CLIENTE, CONV_FORNECEDOR_PESSOAL, org, FORNECEDOR, CLIENTE, channel, FORNECEDOR_PESSOAL],
  );

  // A disponibilidade acima dispara `fn_wake_channel_routing` e enfileira TUDO
  // que está sem dono na organização (inclusive as fixtures do gov-helpers). O
  // arquivo mede uma conversa por vez: a fila é zerada e o pedido é explícito.
  await query("delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'", [org]);
});

describe("rodízio não distribui contato do tipo fornecedor (#3937)", () => {
  it("fornecedor: a conversa fica sem dono e o pedido fecha — não volta ao rodízio", async () => {
    await query("select public.fn_request_channel_routing($1,$2)", [org, CONV_FORNECEDOR]);
    expect((await eventoDo(CONV_FORNECEDOR))?.status).toBe("pending");

    const resultado = await rodarWorker();

    // A asserção do DEFEITO vem primeiro: no código antigo a conversa de
    // fornecedor recebia dono e o teste reprovava aqui, com o nome de quem a
    // recebeu — não num contador.
    expect(await conversa(CONV_FORNECEDOR)).toMatchObject({
      assigned_to_user_id: null,
      assignee_kind: null,
      status: "open",
    });
    expect(resultado.outcomes.assigned).toBe(0);
    expect(resultado.outcomes.skipped_contato_fornecedor).toBe(1);
    // O evento fecha com o motivo próprio: sem isso a conversa voltaria a cada
    // tick do cron (1×/min) e continuaria consumindo a fila.
    const evento = await eventoDo(CONV_FORNECEDOR);
    expect(evento).toMatchObject({ status: "done" });
    expect(evento?.metadata.outcome).toBe("skipped_contato_fornecedor");
  });

  it("cliente: continua entrando no rodízio (a exclusão não é 'ninguém entra')", async () => {
    await query("select public.fn_request_channel_routing($1,$2)", [org, CONV_CLIENTE]);

    const resultado = await rodarWorker();

    expect(resultado.outcomes.assigned).toBe(1);
    expect(resultado.outcomes.skipped_contato_fornecedor).toBe(0);
    expect(await conversa(CONV_CLIENTE)).toMatchObject({
      assigned_to_user_id: ana,
      assignee_kind: "user",
      status: "claimed",
    });
  });

  it("fornecedor E pessoal juntos: vale a régua de HOJE (pessoal), sem filtro duplo", async () => {
    await query("select public.fn_request_channel_routing($1,$2)", [org, CONV_FORNECEDOR_PESSOAL]);

    const resultado = await rodarWorker();

    expect(resultado.outcomes.skipped_contato_pessoal).toBe(1);
    expect(resultado.outcomes.skipped_contato_fornecedor).toBe(0);
    expect(await conversa(CONV_FORNECEDOR_PESSOAL)).toMatchObject({ assigned_to_user_id: null });
  });

  it("release não pede mais o rodízio, e a conversa de fornecedor fica sem dono (#3937)", async () => {
    // Dá dono à conversa de fornecedor por escrita direta: é o estado de quem
    // recebeu antes desta fatia.
    await query(
      "update conversations set assigned_to_user_id=$1, assignee_kind='user', status='claimed', assigned_at=now() where organization_id=$2 and id=$3",
      [ana, org, CONV_FORNECEDOR],
    );
    await query("delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'", [org]);

    // "Liberar": exatamente o que a rota faz — `fn_conversation_assign` com
    // `p_to_user_id` nulo e reason 'release' (release/route.ts:44-49).
    await query("select public.fn_conversation_assign($1,$2,null,'release')", [org, CONV_FORNECEDOR]);

    // A porta do "Liberar" NÃO pede mais o rodízio (migration 9332, decisão do
    // mantenedor). Antes dela este caso afirmava `status='pending'`: a conversa
    // liberada era reenfileirada na mesma transação e voltava a girar até o
    // worker recusá-la — o defeito 2 da issue, medido e não consertado.
    expect(await eventoDo(CONV_FORNECEDOR)).toBeUndefined();

    const resultado = await rodarWorker();

    expect(resultado.batch_size).toBe(0);
    expect(await conversa(CONV_FORNECEDOR)).toMatchObject({ assigned_to_user_id: null, status: "open" });
  });
});
