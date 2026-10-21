import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ISSUE #3015 — A CONVERSA ENCERRADA REABRE MESMO COM A MENSAGEM FORA DE ORDEM.
 *
 * O defeito não era o par por canal nem o `upsert`: `fn_upsert_wa_conversation`
 * devolve a conversa do par (contato, canal) que já existe — fechada continua
 * fechada — e quem reabre é `fn_service_inbound`, disparado pelo gatilho
 * `trg_demanda_abre_no_inbound` no INSERT da mensagem. Só que ele descartava a
 * mensagem ANTES de decidir a reabertura:
 *
 *     if m.sent_at <= c.service_closed_at then return; end if;   -- (antes)
 *     reopened := c.status in ('closed','resolved','archived');
 *
 * Entrega atrasada do canal, lote do provider e relógio do aparelho do cliente
 * atrás produzem `sent_at` ANTERIOR ao fechamento. O guard devolvia cedo, nada
 * acontecia, a conversa seguia `closed` COM a mensagem dentro e o Inbox não a
 * mostrava (a aba Fila é `comando_da_conversa = 'aguardando'`, e `closed` vira
 * `encerrada`). O atendente perdia o cliente sem erro em lugar nenhum.
 *
 * O conserto move o guard para DEPOIS do cálculo de `reopened`, restringindo-o
 * ao caminho que NÃO reabre (`if not reopened and …`). A reabertura passa a ser
 * decidida pela CHEGADA, não pela ordem do `sent_at` — que continua ordenando a
 * timeline e carimbando `service_started_at`.
 *
 * O que este arquivo mede, na ordem:
 *   1. o defeito: fora de ordem em conversa encerrada reabre e volta à Fila;
 *   2. o que o guard protegia e continua protegido: a SEGUNDA mensagem atrasada
 *      do mesmo episódio não reabre de novo (a conversa já está `open`);
 *   3. controle: mensagem NOVA numa conversa nova do canal B nasce `open` e
 *      aparece, com a conversa do canal A aberta e atribuída (trava ligada);
 *   4. controle: mensagem EM ORDEM depois do fechamento continua reabrindo;
 *   5. controle: reentrega da MESMA mensagem (mesmo `external_id`) não duplica
 *      nem reabre por engano;
 *   6. controle: a conversa do canal A (aberta e atribuída) não muda quando
 *      chega mensagem no canal B.
 *
 * Roda só pela suíte de invariantes (`pnpm test:db <arquivo>`), contra o
 * Postgres efêmero com o `baseline.sql` aplicado em install E update.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

// Namespace 3015: não colide com as fixtures de gov-helpers (cccc)/rls (aaaa/bbbb).
const ORG = "3015aaaa-0000-4000-8000-000000000001";
const CANAL_A = "3015aaaa-2222-4000-8000-000000000001"; // número da atendente
const CANAL_B = "3015aaaa-2222-4000-8000-000000000002"; // o par que fecha e recebe atrasada
const CONTATO = "3015aaaa-3333-4000-8000-000000000001";
const ATENDENTE = "3015aaaa-1111-4000-8000-000000000001";

async function criarCanal(id: string, nome: string) {
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status, phone_number, display_name)
     values ($1,$2,$3,'\\x00'::bytea,'WORKING',$4,$5)
     on conflict (id) do nothing`,
    [id, ORG, nome, `+5511${nome.slice(-4)}`, nome],
  );
}

async function conversa(sessionId: string) {
  const { rows } = await pool.query<{ id: string }>(
    "select fn_upsert_wa_conversation($1,$2,$3) as id",
    [ORG, CONTATO, sessionId],
  );
  return rows[0]!.id;
}

/** `sent_atFixo` é o payload do canal: é ELE que a entrega atrasada traz no passado. */
async function inbound(
  conversationId: string,
  sessionId: string,
  externalId: string,
  sentAt: string | Date,
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                           external_id, type, direction, status, sent_via, body, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','external_device','mensagem do cliente',$6)
     returning id`,
    [ORG, conversationId, sessionId, CONTATO, externalId, sentAt],
  );
  return rows[0]!.id;
}

/** O que a tela lê: status, dono, revisão de serviço e o comando (quem manda). */
async function estado(conversationId: string) {
  const { rows } = await pool.query<{
    status: string;
    assigned_to_user_id: string | null;
    service_revision: string;
    service_closed_at: Date | null;
    service_started_at: Date | null;
    comando_da_conversa: string;
  }>(
    `select c.status, c.assigned_to_user_id, c.service_revision,
            c.service_closed_at, c.service_started_at, c.comando_da_conversa
       from public.conversations c where c.id = $1`,
    [conversationId],
  );
  return rows[0]!;
}

async function fechar(conversationId: string) {
  const antes = await estado(conversationId);
  await pool.query("select fn_service_status($1,$2,'closed',$3)", [
    ORG,
    conversationId,
    antes.service_revision,
  ]);
  return estado(conversationId);
}

const carimboDaMensagem = async (messageId: string) =>
  (
    await pool.query<{ service_revision: string | null }>(
      "select service_revision from messages where id = $1",
      [messageId],
    )
  ).rows[0]!.service_revision;

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'org-3015','Org 3015','Org 3015') on conflict (id) do nothing`,
    [ORG],
  );
  await criarCanal(CANAL_A, "sessao-natalia");
  await criarCanal(CANAL_B, "sessao-ana");
  await pool.query("insert into auth.users (id,email) values ($1,'atendente@t3015.test')", [
    ATENDENTE,
  ]);
  await pool.query(
    `insert into user_organizations (organization_id,user_id,role) values ($1,$2,'agent')`,
    [ORG, ATENDENTE],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name) values ($1,$2,'Cliente 3015')`,
    [CONTATO, ORG],
  );
  // Canal B já viveu: a conversa do par (contato, sessao-natalia) existiu, foi
  // fechada e é ela que recebe a entrega atrasada.
  const b = await conversa(CANAL_B);
  await inbound(b, CANAL_B, "wamid.B0", new Date());
  await fechar(b);
  expect((await estado(b)).status, "pré-condição: o par do canal B começa fechado").toBe("closed");
  // Trava do contato ligada: quem manda é gente (é o comando que a Fila pede).
  await pool.query("update contacts set force_human = true where id = $1 and organization_id = $2", [
    CONTATO,
    ORG,
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe("#3015 — mensagem fora de ordem não perde mais o cliente", () => {
  it("1 · fora de ordem em conversa encerrada REABRE e volta para a Fila (o defeito)", async () => {
    const b = (await pool.query<{ id: string }>(
      "select id from conversations where organization_id=$1 and channel_session_id=$2",
      [ORG, CANAL_B],
    )).rows[0]!.id;

    // ANTES: encerrada — é o estado em que o cliente se perdia.
    const antes = await estado(b);
    expect({ status: antes.status, comando: antes.comando_da_conversa }).toEqual({
      status: "closed",
      comando: "encerrada",
    });

    // A entrega chega AGORA, mas com o `sent_at` de uma hora atrás — o relógio
    // do canal atrasou a mensagem para trás do fechamento.
    const enviadaEm = new Date(antes.service_closed_at!.getTime() - 60 * 60 * 1000);
    const msg = await inbound(b, CANAL_B, "wamid.B1_ATRASADA", enviadaEm);

    const depois = await estado(b);
    expect(depois.status, "a conversa encerrada reabre").toBe("open");
    expect(depois.comando_da_conversa, "a aba Fila pede exatamente este comando").toBe("aguardando");
    expect(depois.assigned_to_user_id).toBeNull();
    expect(Number(depois.service_revision)).toBe(Number(antes.service_revision) + 1);
    expect(depois.service_started_at?.toISOString(), "sent_at segue ordenando o episódio").toBe(
      enviadaEm.toISOString(),
    );
    expect(
      await carimboDaMensagem(msg),
      "a mensagem entra no episódio novo (sem carimbo ela sai da memória do atendimento)",
    ).not.toBeNull();
    expect(
      (
        await pool.query<{ n: number }>(
          `select count(*)::int n from conversations c
            where c.organization_id=$1 and c.comando_da_conversa = 'aguardando'`,
          [ORG],
        )
      ).rows[0]!.n,
      "a conversa aparece na Fila do Inbox",
    ).toBe(1);
  });

  it("2 · a segunda atrasada do mesmo episódio NÃO reabre de novo (o que o guard protegia)", async () => {
    const b = (await pool.query<{ id: string }>(
      "select id from conversations where organization_id=$1 and channel_session_id=$2",
      [ORG, CANAL_B],
    )).rows[0]!.id;
    const antes = await estado(b);
    expect(antes.status).toBe("open");

    await inbound(b, CANAL_B, "wamid.B2_ANTIGA", new Date(Date.now() - 3 * 60 * 60 * 1000));

    const depois = await estado(b);
    expect(depois.status, "não há reabertura dupla pelo mesmo atraso").toBe("open");
    expect(
      Number(depois.service_revision),
      "a revisão de serviço não soma duas vezes por causa da mesma rajada",
    ).toBe(Number(antes.service_revision));
  });

  it("3 · controle: mensagem NOVA no canal B com o canal A aberto e atribuído nasce `open` e aparece", async () => {
    // Canal A: conversa aberta e ATRIBUÍDA à atendente (o estado da conversa ativa).
    const a = await conversa(CANAL_A);
    await pool.query(
      "update conversations set assigned_to_user_id=$1, status='claimed', assigned_at=now() where id=$2",
      [ATENDENTE, a],
    );
    await inbound(a, CANAL_A, "wamid.A1", new Date());

    // Canal B: a conversa do DEFEITO acima já está aberta; o que este caso mede é
    // o par novo por canal, que já nasce `open` (nada a reabrir).
    const nova = await conversa(CANAL_B);
    const msgNova = await inbound(nova, CANAL_B, `wamid.B_${randomUUID()}`, new Date());

    const b = await estado(nova);
    expect(b.status).toBe("open");
    expect(b.comando_da_conversa).toBe("aguardando");
    expect(await carimboDaMensagem(msgNova)).not.toBeNull();
  });

  it("4 · controle: mensagem EM ORDEM depois do fechamento continua reabrindo", async () => {
    const b = (await pool.query<{ id: string }>(
      "select id from conversations where organization_id=$1 and channel_session_id=$2",
      [ORG, CANAL_B],
    )).rows[0]!.id;
    const fechada = await fechar(b);
    expect(fechada.status).toBe("closed");

    await inbound(b, CANAL_B, "wamid.B3_EM_ORDEM", new Date());

    const depois = await estado(b);
    expect(depois.status).toBe("open");
    expect(depois.comando_da_conversa).toBe("aguardando");
    expect(Number(depois.service_revision)).toBe(Number(fechada.service_revision) + 1);
  });

  it("5 · controle: reentrega da MESMA mensagem não duplica nem reabre por engano", async () => {
    const b = (await pool.query<{ id: string }>(
      "select id from conversations where organization_id=$1 and channel_session_id=$2",
      [ORG, CANAL_B],
    )).rows[0]!.id;
    const fechada = await fechar(b);
    const antes = (
      await pool.query<{ n: number }>(
        "select count(*)::int n from messages where conversation_id=$1",
        [b],
      )
    ).rows[0]!.n;

    // Mesmo `external_id` já ingerido: a ingestão (lib/waha/ingest.ts) trata o
    // 23505 como dedup e nem tenta a linha de novo.
    await expect(inbound(b, CANAL_B, "wamid.B3_EM_ORDEM", new Date())).rejects.toMatchObject({
      code: "23505",
    });

    const depois = await estado(b);
    expect(depois.status, "a reentrega não reabre o atendimento encerrado").toBe("closed");
    expect(Number(depois.service_revision)).toBe(Number(fechada.service_revision));
    expect(
      (
        await pool.query<{ n: number }>(
          "select count(*)::int n from messages where conversation_id=$1",
          [b],
        )
      ).rows[0]!.n,
      "nenhuma mensagem duplicada",
    ).toBe(antes);
  });

  it("6 · controle: a conversa do canal A não muda quando chega mensagem no canal B", async () => {
    const a = (await pool.query<{ id: string }>(
      "select id from conversations where organization_id=$1 and channel_session_id=$2",
      [ORG, CANAL_A],
    )).rows[0]!.id;
    const antesA = await estado(a);
    expect(antesA.assigned_to_user_id, "pré-condição: o canal A está com a atendente").toBe(
      ATENDENTE,
    );

    const b = (await pool.query<{ id: string }>(
      "select id from conversations where organization_id=$1 and channel_session_id=$2",
      [ORG, CANAL_B],
    )).rows[0]!.id;
    await inbound(b, CANAL_B, `wamid.B_${randomUUID()}`, new Date(Date.now() - 5 * 60 * 1000));

    const depoisA = await estado(a);
    expect(
      {
        status: depoisA.status,
        dono: depoisA.assigned_to_user_id,
        revisao: Number(depoisA.service_revision),
        comando: depoisA.comando_da_conversa,
      },
      "o recorte por par (contato, canal) não vaza para outra conversa do contato",
    ).toEqual({
      status: antesA.status,
      dono: antesA.assigned_to_user_id,
      revisao: Number(antesA.service_revision),
      comando: antesA.comando_da_conversa,
    });
  });
});
