import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runRoutingWorker } from "@/lib/routing/worker";
import { createAdminClient } from "@/lib/supabase/admin";

import { routingPgSupabase } from "../support/routing-pg-supabase";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

/**
 * A MENSAGEM NOVA DO CLIENTE ACORDA O ROTEAMENTO DA CONVERSA SEM DONO (#3916).
 *
 * ─── O caminho que não existia ─────────────────────────────────────────────
 *
 * O pedido `conversation.routing_requested` nasce em UM lugar:
 * `trg_conversation_routing_requested` (`supabase/baseline.sql`, `after insert on
 * conversations`, `when` sem dono e `open`/`pending`). Uma conversa que JÁ existe
 * e continua sem dono não muda `status` nem `assigned_to_user_id` quando o
 * cliente escreve de novo — `fn_upsert_wa_conversation` só toca `updated_at` no
 * ramo de conflito —, e `trg_routing_assignment_changed` é
 * `after update OF assigned_to_user_id,status`: nenhum dos dois vê a mensagem.
 * Resultado: a conversa só voltava para a distribuição pelo laço de retentativa
 * do worker, que a reagenda para sempre (`lib/routing/decide.ts:128-132`).
 *
 * ─── A régua deste arquivo ─────────────────────────────────────────────────
 *
 * O pedido do INSERT da conversa é consumido ANTES do caso (o worker o teria
 * consumido: `done`), porque o que se mede aqui é o efeito da MENSAGEM. Assim a
 * primeira asserção de cada caso — zero pedido vivo — é o estado em que a
 * conversa fica sem o laço, que é exatamente o buraco que a issue descreve.
 *
 * E o que se cobra é UM pedido, não um por mensagem: o índice único parcial
 * `event_log_routing_active_unique` (`(organization_id, entity_id)` para
 * `conversation.routing_requested` em `pending`/`processing`) é quem responde
 * "cinco mensagens seguidas = um pedido".
 *
 * ─── Por que org, sessão e contatos próprios ───────────────────────────────
 *
 * `tests/invariants/channel-routing.test.ts` roda em paralelo no MESMO banco e
 * tem `beforeEach` que devolve toda conversa de `GOV_ORG` para `open` sem dono.
 * Medir "conversa com dono não emite" no seed compartilhado seria uma corrida
 * com ele. As UUIDs são fixas (namespace `eeeeeeee`) e nascem com
 * `on conflict do nothing`, então os arquivos se reencontram sem duplicar.
 */
const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const OUTRA_ORG = "eeeeeeee-0000-4000-8000-000000000002";
const SESSAO = "eeeeeeee-2222-4000-8000-000000000001";
const DONO = "eeeeeeee-1111-4000-8000-000000000001";
const MEMBRO_DA_OUTRA_ORG = "eeeeeeee-1111-4000-8000-000000000002";

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

/** SELECT como um membro da organização, do jeito que o PostgREST faz. */
async function asUser(user: string, text: string, args: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, aal: "aal1" }),
    ]);
    const result = await client.query(text, args);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await query(
    `insert into auth.users(id,email) values ($1,'rta-dono@invariant.test'),($2,'rta-outra@invariant.test')
     on conflict do nothing`,
    [DONO, MEMBRO_DA_OUTRA_ORG],
  );
  await query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'rta-inv','RTA Invariant','RTA Inv'),($2,'rta-outra','Outra RTA','Outra RTA')
     on conflict do nothing`,
    [ORG, OUTRA_ORG],
  );
  await query(
    `insert into user_organizations(organization_id,user_id,role,accepted_at)
     values ($1,$2,'agent',now()),($3,$4,'admin',now()) on conflict do nothing`,
    [ORG, DONO, OUTRA_ORG, MEMBRO_DA_OUTRA_ORG],
  );
  await query(
    `do $rta$ begin
       insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
         values ('${SESSAO}','${ORG}','rta-inv','\\x00'::bytea);
     exception when unique_violation then null; end $rta$;`,
  );
  // O modo importa para o worker: `manual` (o padrão da organização) consome o
  // pedido sem distribuir, e o caso que prova o consumo precisa da fila viva.
  await query(
    `update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{routing}',
       '{"mode":"round_robin","max_retries":5,"backoff_seconds":60}'::jsonb) where id=$1`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await query("delete from event_log where organization_id=$1", [ORG]);
  await query("delete from channel_routing_policies where organization_id=$1", [ORG]);
  await query("delete from attendant_availability where organization_id=$1", [ORG]);
});

/**
 * Conversa nova, com dono/estado controlados pelo caso, e o pedido que o INSERT
 * dela cria JÁ CONSUMIDO (`done`) — como fica depois de o worker drenar sem
 * conseguir distribuir. `pedidoInicial: "pending"` preserva o pedido vivo, que é
 * o estado do laço de retentativa.
 */
async function conversa(
  opts: { status?: string; dono?: string | null; grupo?: boolean; pedidoInicial?: "done" | "pending" } = {},
) {
  const contact = randomUUID();
  const id = randomUUID();
  await query("insert into contacts(id,organization_id,display_name) values($1,$2,'Cliente RTA')", [
    contact,
    ORG,
  ]);
  await query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,assigned_to_user_id,assigned_at)
     values($1,$2,$3,$4,$5,$6,$7,case when $7::uuid is null then null else clock_timestamp() end)`,
    [id, ORG, contact, SESSAO, opts.status ?? "open", opts.grupo ?? false, opts.dono ?? null],
  );
  if ((opts.pedidoInicial ?? "done") === "done") {
    await query(
      `update event_log set status='done'
        where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'`,
      [ORG, id],
    );
  }
  return { id, contact };
}

/**
 * A mensagem do cliente como o ingest a grava (`lib/channels/meta/ingest.ts:270`,
 * `lib/waha/ingest.ts`): `direction='inbound'`, `status='delivered'`, sem
 * `sent_via` (o default é `crm`). O que este arquivo mede é o GATILHO do banco,
 * então o INSERT cru é o caminho de verdade — nenhuma rota é chamada aqui.
 */
async function clienteEscreve(
  conversation: string,
  contact: string,
  extra: { metadata?: Record<string, unknown>; tipo?: string; direction?: "inbound" | "outbound"; sentVia?: string } = {},
) {
  const id = randomUUID();
  await query(
    `insert into messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,sent_via,body,sent_at,metadata)
     values($1,$2,$3,$4,$5,$6,$7,$8,'delivered',$9,'Bom dia',clock_timestamp(),$10::jsonb)`,
    [
      id,
      ORG,
      conversation,
      SESSAO,
      contact,
      `rta-${id}`,
      extra.tipo ?? "text",
      extra.direction ?? "inbound",
      extra.sentVia ?? "crm",
      JSON.stringify(extra.metadata ?? {}),
    ],
  );
  return id;
}

/** Os pedidos de roteamento DESTA conversa, na ordem em que nasceram. */
async function pedidos(conversation: string) {
  const { rows } = await query(
    `select status, attempts, next_attempt_at::text as next_attempt_at, payload, consumed_by, metadata
       from event_log
      where organization_id=$1 and event_type='conversation.routing_requested' and entity_id=$2
      order by created_at, id`,
    [ORG, conversation],
  );
  return rows as Array<{
    status: string;
    attempts: number;
    next_attempt_at: string | null;
    payload: Record<string, unknown>;
    consumed_by: string[] | null;
    metadata: Record<string, unknown> | null;
  }>;
}

/** O pedido VIVO da conversa (na fila ou em processamento). */
async function vivo(conversation: string) {
  const { rows } = await query(
    `select id, status, attempts, next_attempt_at::text as next_attempt_at, payload
       from event_log
      where organization_id=$1 and event_type='conversation.routing_requested' and entity_id=$2
        and status in ('pending','processing')`,
    [ORG, conversation],
  );
  return rows as Array<{
    id: string;
    status: string;
    attempts: number;
    next_attempt_at: string | null;
    payload: Record<string, unknown>;
  }>;
}

describe("a mensagem nova do cliente em conversa sem dono pede roteamento (#3916)", () => {
  it("uma mensagem nova em conversa aberta e sem dono cria UM pedido com a organização da conversa", async () => {
    const { id: conversation, contact } = await conversa();
    expect(await vivo(conversation)).toHaveLength(0);

    await clienteEscreve(conversation, contact);

    const abertos = await vivo(conversation);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]?.payload).toMatchObject({
      organization_id: ORG,
      conversation_id: conversation,
      channel_session_id: SESSAO,
    });
    // O evento nasce drenável: pendente, sem espera e com o contador zerado.
    expect(abertos[0]?.status).toBe("pending");
    expect(abertos[0]?.attempts).toBe(0);
    const semEspera = abertos[0]?.next_attempt_at;
    expect(
      semEspera === null || semEspera === undefined || new Date(semEspera).getTime() <= Date.now() + 5_000,
    ).toBe(true);
  });

  it("cinco mensagens seguidas na mesma conversa sem dono continuam sendo UM pedido", async () => {
    const { id: conversation, contact } = await conversa();

    for (let i = 0; i < 5; i += 1) {
      await clienteEscreve(conversation, contact);
    }

    expect(await vivo(conversation)).toHaveLength(1);
    expect(await pedidos(conversation)).toHaveLength(2); // o consumido do INSERT + o vivo
  });

  it("a conversa sem dono continua acordável com o laço em espera longa (teto de tentativas)", async () => {
    const { id: conversation, contact } = await conversa({ pedidoInicial: "pending" });
    expect(await vivo(conversation)).toHaveLength(1);
    // O estado em que o laço de retentativa deixa a conversa: evento pendente,
    // contador no teto e a próxima tentativa daqui a uma hora.
    await query(
      `update event_log set attempts=5, next_attempt_at=now()+interval '1 hour'
        where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'`,
      [ORG, conversation],
    );

    await clienteEscreve(conversation, contact);

    const abertos = await vivo(conversation);
    expect(abertos).toHaveLength(1);
    expect(new Date(abertos[0]!.next_attempt_at!).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("depois de consumido, o pedido volta a nascer na mensagem seguinte", async () => {
    const { id: conversation, contact } = await conversa();
    expect((await pedidos(conversation)).map((p) => p.status)).toEqual(["done"]);

    await clienteEscreve(conversation, contact);

    const todos = await pedidos(conversation);
    expect(todos.map((p) => p.status).sort()).toEqual(["done", "pending"]);
  });

  it("o worker real consome o pedido que a mensagem criou", async () => {
    const { id: conversation, contact } = await conversa();
    await clienteEscreve(conversation, contact);
    expect(await vivo(conversation)).toHaveLength(1);

    // Sem atendente disponível: o worker pega o evento e o reagenda — o que se
    // prova é o CONSUMO (o contador anda e a espera é recalculada), não a
    // atribuição.
    const adapter = routingPgSupabase(pool);
    vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
    const agora = new Date();
    await runRoutingWorker({ now: agora, batchSize: 100 });

    const [evento] = await pedidos(conversation).then((rows) => rows.filter((r) => r.status === "pending"));
    expect(evento?.attempts).toBe(1);
    expect(new Date(evento!.next_attempt_at!).getTime()).toBeGreaterThan(agora.getTime());
    expect(adapter.errors).toEqual([]);
  });
});

describe("o que NÃO acorda o roteamento", () => {
  it("conversa com dono não emite pedido nenhum", async () => {
    const { id: conversation, contact } = await conversa({ status: "claimed", dono: DONO });
    expect(await pedidos(conversation)).toHaveLength(0);

    await clienteEscreve(conversation, contact);

    expect(await pedidos(conversation)).toHaveLength(0);
  });

  it("conversa fechada que recebe mensagem volta para a fila com UM pedido (o da reabertura)", async () => {
    const { id: conversation, contact } = await conversa({ status: "closed" });
    expect(await pedidos(conversation)).toHaveLength(0);

    await clienteEscreve(conversation, contact);

    const { rows } = await query("select status from conversations where id=$1", [conversation]);
    expect(rows[0]?.status).toBe("open");
    // A reabertura é `trg_routing_assignment_changed`; o gatilho da mensagem não
    // pode somar um segundo pedido por cima do mesmo evento.
    expect(await vivo(conversation)).toHaveLength(1);
  });

  it("mensagem enviada pela equipe não emite (só a entrada do cliente)", async () => {
    const { id: conversation, contact } = await conversa();

    await clienteEscreve(conversation, contact, { direction: "outbound", sentVia: "user" });
    await clienteEscreve(conversation, contact, { direction: "outbound", sentVia: "external_device" });

    expect(await vivo(conversation)).toHaveLength(0);
  });

  it("reação do cliente e histórico importado não são fala nova", async () => {
    const reacao = await conversa();
    await clienteEscreve(reacao.id, reacao.contact, { tipo: "reaction" });

    const importada = await conversa();
    await clienteEscreve(importada.id, importada.contact, { metadata: { historico_importado: "true" } });

    expect(await vivo(reacao.id)).toHaveLength(0);
    expect(await vivo(importada.id)).toHaveLength(0);
  });

  it("conversa de grupo sem dono não entra na distribuição", async () => {
    const { id: conversation, contact } = await conversa({ grupo: true });

    await clienteEscreve(conversation, contact);

    expect(await vivo(conversation)).toHaveLength(0);
  });

  it("número com distribuição manual e sem destino padrão não emite", async () => {
    await query(
      "insert into channel_routing_policies(organization_id,channel_session_id,distribution_mode) values($1,$2,'manual')",
      [ORG, SESSAO],
    );
    const { id: conversation, contact } = await conversa();

    for (let i = 0; i < 3; i += 1) {
      await clienteEscreve(conversation, contact);
    }

    expect(await vivo(conversation)).toHaveLength(0);
  });

  it("número manual COM destino padrão emite — ali existe para quem entregar", async () => {
    await query(
      "insert into channel_routing_policies(organization_id,channel_session_id,distribution_mode,default_assignee_user_id) values($1,$2,'manual',$3)",
      [ORG, SESSAO, DONO],
    );
    const { id: conversation, contact } = await conversa();

    await clienteEscreve(conversation, contact);

    expect(await vivo(conversation)).toHaveLength(1);
  });
});

/** O modo de distribuição da ORGANIZAÇÃO (`settings.routing.mode`). */
const modoDaOrganizacao = (mode: string) =>
  query(
    `update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{routing,mode}',to_jsonb($2::text)) where id=$1`,
    [ORG, mode],
  );

/**
 * O DEFEITO QUE A REVISÃO DO #4193 APONTOU. A primeira versão do gatilho só
 * consultava `channel_routing_policies`: numa organização em modo manual (o
 * padrão de fábrica) e sem regra por número, cada mensagem recebida em conversa
 * sem dono gravava um evento que o worker fechava com `manual_mode`, sem
 * entregar. A régua certa é a do worker: destino padrão do número, ou modo
 * efetivo (número, senão organização) em rodízio ou menor carga.
 */
describe("o gatilho só pede onde a distribuição automática vale", () => {
  afterEach(() => modoDaOrganizacao("round_robin"));

  it("⭐ organização em modo manual, sem regra por número: ZERO evento, por mais que o cliente escreva", async () => {
    await modoDaOrganizacao("manual");
    const { id: conversation, contact } = await conversa();

    for (let i = 0; i < 3; i += 1) {
      await clienteEscreve(conversation, contact);
    }

    expect(await vivo(conversation)).toHaveLength(0);
    expect((await pedidos(conversation)).map((p) => p.status)).toEqual(["done"]); // só o do INSERT
  });

  it("organização sem `settings.routing` nenhum é manual: zero evento", async () => {
    await query("update organizations set settings=coalesce(settings,'{}'::jsonb) - 'routing' where id=$1", [ORG]);
    try {
      const { id: conversation, contact } = await conversa();
      await clienteEscreve(conversation, contact);
      expect(await vivo(conversation)).toHaveLength(0);
    } finally {
      await query(
        `update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{routing}',
           '{"mode":"round_robin","max_retries":5,"backoff_seconds":60}'::jsonb) where id=$1`,
        [ORG],
      );
    }
  });

  it.each(["round_robin", "load"])("⭐ organização em modo automático (%s): UM evento", async (mode) => {
    await modoDaOrganizacao(mode);
    const { id: conversation, contact } = await conversa();

    await clienteEscreve(conversation, contact);

    expect(await vivo(conversation)).toHaveLength(1);
  });

  it("⭐ duas mensagens seguidas com o pedido pendente: UM evento só, e nenhuma linha nova", async () => {
    const { id: conversation, contact } = await conversa();

    await clienteEscreve(conversation, contact);
    const [primeiro] = await vivo(conversation);
    await clienteEscreve(conversation, contact);

    const depois = await vivo(conversation);
    expect(depois.map((p) => p.id)).toEqual([primeiro?.id]);
    expect(await pedidos(conversation)).toHaveLength(2); // o consumido do INSERT + o vivo
  });

  it("organização manual, mas o NÚMERO em rodízio: a regra do número vence e o pedido nasce", async () => {
    await modoDaOrganizacao("manual");
    await query(
      "insert into channel_routing_policies(organization_id,channel_session_id,distribution_mode) values($1,$2,'round_robin')",
      [ORG, SESSAO],
    );
    const { id: conversation, contact } = await conversa();

    await clienteEscreve(conversation, contact);

    expect(await vivo(conversation)).toHaveLength(1);
  });

  it("organização manual, número com regra SEM modo próprio (só responsáveis): herda o manual, zero evento", async () => {
    await modoDaOrganizacao("manual");
    await query("insert into channel_routing_policies(organization_id,channel_session_id) values($1,$2)", [
      ORG,
      SESSAO,
    ]);
    const { id: conversation, contact } = await conversa();

    await clienteEscreve(conversation, contact);

    expect(await vivo(conversation)).toHaveLength(0);
  });
});

/**
 * O CASO QUE MOTIVOU A ENTRADA DESTE GATILHO (doc 309, A1). Desde a 9346
 * "Liberar" não pede rodízio: a conversa liberada fica sem dono e sem pedido.
 * Sem este gatilho, o cliente que escrevesse de novo esperaria a equipe mudar de
 * disponibilidade. Aqui a porta é a de produção: `fn_conversation_assign` com
 * destino nulo e `reason='release'`, a mesma da rota do botão.
 */
describe("conversa LIBERADA volta à distribuição quando o cliente escreve de novo", () => {
  it("⭐ liberar não cria pedido; a mensagem nova do cliente cria UM", async () => {
    const { id: conversation, contact } = await conversa({ status: "claimed", dono: DONO });
    expect(await pedidos(conversation)).toHaveLength(0);

    await query("select public.fn_conversation_assign($1,$2,null,'release')", [ORG, conversation]);
    const liberada = await query("select assigned_to_user_id, status from conversations where id=$1", [conversation]);
    expect(liberada.rows[0]).toMatchObject({ assigned_to_user_id: null, status: "open" });
    // O contrato do #4404: liberar, sozinho, não devolve a conversa ao rodízio.
    expect(await pedidos(conversation)).toHaveLength(0);

    await clienteEscreve(conversation, contact);
    await clienteEscreve(conversation, contact);

    expect(await vivo(conversation)).toHaveLength(1);
    expect(await pedidos(conversation)).toHaveLength(1);
  });

  it("liberada em organização de modo manual continua parada: ali ninguém pediu distribuição", async () => {
    await modoDaOrganizacao("manual");
    try {
      const { id: conversation, contact } = await conversa({ status: "claimed", dono: DONO });
      await query("select public.fn_conversation_assign($1,$2,null,'release')", [ORG, conversation]);

      await clienteEscreve(conversation, contact);

      expect(await pedidos(conversation)).toHaveLength(0);
    } finally {
      await modoDaOrganizacao("round_robin");
    }
  });
});

/**
 * A ESPERA PELA IA (#3966, migration 9333). No número que ligou
 * `ai_wait_minutes`, o worker guarda o pedido até o prazo enquanto a IA
 * qualifica. A mensagem nova traz o pedido para agora, mas não pode furar a
 * espera nem empurrar o prazo: o `desde` mora no `metadata` do evento, que
 * `fn_request_channel_routing` não toca.
 */
describe("número com espera pela IA: a mensagem nova não fura o prazo", () => {
  afterEach(async () => {
    await query("delete from ai_agents where organization_id=$1", [ORG]);
    await query("delete from ai_agent_versions where organization_id=$1", [ORG]);
    await query("delete from agent_inbox_items where organization_id=$1 and kind='routing_ia_wait_expired'", [ORG]);
  });

  it("⭐ o pedido acordado pela mensagem volta para o MESMO prazo e não distribui antes dele", async () => {
    await query(
      "insert into channel_routing_policies(organization_id,channel_session_id,distribution_mode,ai_wait_minutes) values($1,$2,'round_robin',60)",
      [ORG, SESSAO],
    );
    await query(
      `insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule)
         values($1,$2,true,4,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=4,schedule='{}'`,
      [ORG, DONO],
    );
    // O agente publicado NESTE número: é o que faz a IA "estar qualificando".
    const agente = await query(
      "insert into ai_agents(organization_id,name,system_prompt,kind) values($1,'Qualificação RTA','Qualifique.','rag_bot') returning id",
      [ORG],
    );
    const agenteId = (agente.rows[0] as { id: string }).id;
    const versao = await query(
      `insert into ai_agent_versions
         (organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,published_at)
       values($1,$2,1,'Qualifique.','anthropic','claude-sonnet-4-6',$3,'published',now()) returning id`,
      [ORG, agenteId, SESSAO],
    );
    await query("update ai_agents set published_version_id=$1 where id=$2", [
      (versao.rows[0] as { id: string }).id,
      agenteId,
    ]);

    const { id: conversation, contact } = await conversa({ pedidoInicial: "pending" });
    const rodar = async (daquiAMs: number) => {
      const adapter = routingPgSupabase(pool);
      vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
      const result = await runRoutingWorker({ now: new Date(Date.now() + daquiAMs), batchSize: 100 });
      expect(adapter.errors).toEqual([]);
      return result;
    };
    const dono = async () =>
      (await query("select assigned_to_user_id from conversations where id=$1", [conversation])).rows[0]
        ?.assigned_to_user_id as string | null;

    // 1. Nascimento: a IA está qualificando, o pedido fica guardado até o prazo.
    const primeira = await rodar(5_000);
    expect(primeira.outcomes.waiting_ia_qualificando, JSON.stringify(primeira)).toBeGreaterThanOrEqual(1);
    const [guardado] = await vivo(conversation);
    const prazo = new Date(guardado!.next_attempt_at!).getTime();
    expect(prazo).toBeGreaterThan(Date.now() + 50 * 60_000);

    // 2. O cliente escreve: o MESMO pedido vem para agora.
    await clienteEscreve(conversation, contact);
    const acordados = await vivo(conversation);
    expect(acordados.map((p) => p.id)).toEqual([guardado!.id]);
    expect(new Date(acordados[0]!.next_attempt_at!).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);

    // 3. O worker NÃO distribui: devolve o pedido para o MESMO prazo.
    const segunda = await rodar(5_000);
    expect(segunda.outcomes.waiting_ia_qualificando, JSON.stringify(segunda)).toBeGreaterThanOrEqual(1);
    expect(await dono()).toBeNull();
    const [depois] = await vivo(conversation);
    expect(new Date(depois!.next_attempt_at!).getTime()).toBe(prazo);

    // 4. Controle: passado o prazo, a espera acaba e a Central avisa uma vez.
    // (Contagens do worker são globais; a prova é desta conversa.)
    await rodar(61 * 60_000);
    const avisos = await query(
      "select 1 from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='routing_ia_wait_expired'",
      [ORG, conversation],
    );
    expect(avisos.rows).toHaveLength(1);
  });
});

describe("o pedido não atravessa a organização", () => {
  it("a outra organização não vê o evento, e o payload carrega a org da conversa", async () => {
    const { id: conversation, contact } = await conversa();
    await clienteEscreve(conversation, contact);

    const [evento] = await vivo(conversation);
    expect(evento?.payload.organization_id).toBe(ORG);

    const daOutra = await asUser(
      MEMBRO_DA_OUTRA_ORG,
      "select count(*)::int as n from event_log where organization_id=$1",
      [ORG],
    );
    expect(daOutra.rows[0]?.n).toBe(0);

    const daMinha = await asUser(
      DONO,
      "select count(*)::int as n from event_log where organization_id=$1 and event_type='conversation.routing_requested' and status in ('pending','processing')",
      [ORG],
    );
    expect(daMinha.rows[0]?.n).toBe(1);

    // Nada vazou para a outra organização: o pedido é por (organização, conversa).
    const { rows } = await query(
      "select count(*)::int as n from event_log where organization_id=$1 and event_type='conversation.routing_requested'",
      [OUTRA_ORG],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
