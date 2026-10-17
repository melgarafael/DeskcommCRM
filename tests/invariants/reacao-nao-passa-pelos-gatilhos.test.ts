import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A REAÇÃO NÃO PASSA PELOS GATILHOS DE MENSAGEM RECEBIDA (#2797 / #2815).
 *
 * A fatia 1 tirou a reação do caminho de mensagem NO APLICATIVO: `reacao.ts`
 * grava a linha `type='reaction'` ligada ao alvo e não chama
 * `fn_mark_conversation_message` — por isso não move `last_message_at`, a
 * janela de 24h, a prévia nem o contador de não lidas. O que ficou de pé foi o
 * outro lado da tabela: `messages` tem gatilhos de INSERT que não perguntam o
 * `type`, e um 👍 disparava os TRÊS —
 *
 *   * `trg_demanda_abre_no_inbound` → `fn_service_inbound`, que REABRIA a
 *     conversa encerrada e abria uma demanda nova;
 *   * `trg_messages_emit_event` → `message.received`, que alcança a notificação
 *     push, o webhook de saída do cliente, a resposta de campanha e o
 *     follow-up (nenhum filtra o tipo);
 *   * `trg_reply_inbound_revision` → +1 na revisão de contexto.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * A sonda que a triagem rodou em banco real, virada invariante: fecha a
 * conversa com `fn_service_status(…, 'closed', …)`, insere a reação com as
 * colunas que `gravarReacaoDeMensagem` grava (inbound, `type='reaction'`,
 * `body` nulo, `reply_to_message_id` = alvo) e cobra que NADA de mensagem
 * recebida aconteça. Antes do corte `new.type = 'reaction'` nas três funções
 * da migration 0684, o mesmo INSERT devolvia a conversa `open`,
 * `reply_context_revision` de 2 para 4 e o `event_log` da reação nascia
 * `["message.received"]`.
 *
 * O contrato que se guarda é o do PR: a linha da reação CONTINUA sendo gravada
 * (nada de recusar a escrita — quem descarta é o escritor, quando o alvo não
 * existe), e o que ela NÃO faz é contar como fala.
 *
 * Os dois controles existem para o corte não ter passado do ponto: uma mensagem
 * de VERDADE do cliente ainda reabre e ainda emite `message.received`, e a
 * reação de saída (o operador reagindo) também não inventa evento nenhum.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

beforeAll(() => seedGov());
afterAll(async () => pool.end());

/** Conversa com um alvo real e ENCERRADA — o estado em que a reação reabria. */
async function conversaEncerrada() {
  const contact = randomUUID();
  const conversation = randomUUID();
  const alvo = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Reação')", [
    contact,
    GOV_ORG,
  ]);
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  // O alvo é uma mensagem de VERDADE (o cliente falou) — é o que a reação aponta.
  await pool.query(
    `insert into messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text','inbound','received','ai','Fechado, obrigado!',clock_timestamp())`,
    [alvo, GOV_ORG, conversation, GOV_SESSION, contact],
  );
  await pool.query("select * from fn_service_status($1,$2,'closed',null)", [GOV_ORG, conversation]);
  return { contact, conversation, alvo };
}

/** Insere a linha da reação como `gravarReacaoDeMensagem` a grava. */
async function reagir(args: {
  conversation: string;
  contact: string;
  alvo: string;
  direction?: "inbound" | "outbound";
}) {
  const id = randomUUID();
  await pool.query(
    `insert into messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body,sent_at,reply_to_message_id,metadata)
     values($1,$2,$3,$4,$5,$6,'reaction',$7,'delivered',null,clock_timestamp(),$8,$9::jsonb)`,
    [
      id,
      GOV_ORG,
      args.conversation,
      GOV_SESSION,
      args.contact,
      `reacao-${id}`,
      args.direction ?? "inbound",
      args.alvo,
      JSON.stringify({
        reaction: { emoji: "👍", target_external_id: `wa-${args.alvo}`, author: "5511900000000" },
      }),
    ],
  );
  return id;
}

/** Uma fala de verdade do cliente — o caminho que NÃO pode ter sido desarmado. */
async function clienteEscreve(conversation: string, contact: string) {
  const id = randomUUID();
  await pool.query(
    `insert into messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text','inbound','received','ai','Ainda estou aqui',clock_timestamp())`,
    [id, GOV_ORG, conversation, GOV_SESSION, contact],
  );
  return id;
}

async function estado(conversation: string) {
  const { rows } = await pool.query(
    "select status, reply_context_revision, service_revision from conversations where id=$1 and organization_id=$2",
    [conversation, GOV_ORG],
  );
  return rows[0] as { status: string; reply_context_revision: number; service_revision: number };
}

/** O `event_log` que aponta para a mensagem (fn_log_event usa `message_id`). */
async function eventosDa(messageId: string): Promise<string[]> {
  const { rows } = await pool.query(
    "select event_type from event_log where organization_id=$1 and entity_id=$2 order by event_type",
    [GOV_ORG, messageId],
  );
  return rows.map((r) => r.event_type as string);
}

describe("a reação não é mensagem recebida", () => {
  it("não reabre a conversa encerrada", async () => {
    const { contact, conversation, alvo } = await conversaEncerrada();
    expect((await estado(conversation)).status, "pré-condição: a conversa começa fechada").toBe(
      "closed",
    );

    await reagir({ conversation, contact, alvo });

    const depois = await estado(conversation);
    expect(
      depois.status,
      "o 👍 reabriu a conversa — é o defeito da issue #2797: a reação passou por fn_service_inbound",
    ).toBe("closed");
  });

  it("não emite `message.received` (nem nenhum outro evento)", async () => {
    const { contact, conversation, alvo } = await conversaEncerrada();
    const reacao = await reagir({ conversation, contact, alvo });

    expect(
      await eventosDa(reacao),
      "a reação emitiu evento — chega à push, ao webhook de saída, à campanha e ao follow-up, que não filtram o tipo",
    ).toEqual([]);
  });

  it("não mexe na revisão de contexto", async () => {
    const { contact, conversation, alvo } = await conversaEncerrada();
    const antes = (await estado(conversation)).reply_context_revision;

    await reagir({ conversation, contact, alvo });

    expect(
      (await estado(conversation)).reply_context_revision,
      "o 👍 invalidou o rascunho de resposta da tela à toa",
    ).toBe(antes);
  });

  it("a linha da reação CONTINUA gravada — e sem `service_revision`", async () => {
    const { contact, conversation, alvo } = await conversaEncerrada();
    const reacao = await reagir({ conversation, contact, alvo });

    const { rows } = await pool.query(
      "select type, direction, body, reply_to_message_id, service_revision, metadata->'reaction'->>'emoji' as emoji from messages where id=$1",
      [reacao],
    );
    expect(rows, "a reação não foi gravada — o corte não pode recusar a escrita").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "reaction",
      direction: "inbound",
      body: null,
      reply_to_message_id: alvo,
      service_revision: null,
      emoji: "👍",
    });
  });

  it("controle: a fala de verdade do cliente AINDA reabre e AINDA emite `message.received`", async () => {
    const { contact, conversation } = await conversaEncerrada();

    const fala = await clienteEscreve(conversation, contact);

    expect((await estado(conversation)).status, "o corte passou do ponto: a mensagem real não reabriu").toBe(
      "open",
    );
    expect(await eventosDa(fala), "o corte passou do ponto: a mensagem real não emitiu evento").toContain(
      "message.received",
    );
  });

  it("controle: a reação do OPERADOR também não inventa evento", async () => {
    const { contact, conversation, alvo } = await conversaEncerrada();
    const reacao = await reagir({ conversation, contact, alvo, direction: "outbound" });

    expect(
      await eventosDa(reacao),
      "a reação de saída emitiu `message.outbound` — reação não é mensagem de saída tampouco",
    ).toEqual([]);
  });

  it("o follow-up lê a última FALA do cliente, não o 👍 que veio depois", async () => {
    const { contact, conversation } = await conversaEncerrada();
    const sim = randomUUID();
    await pool.query(
      `insert into messages
         (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
       values($1,$2,$3,$4,$5,'text','inbound','received','ai','SIM',clock_timestamp())`,
      [sim, GOV_ORG, conversation, GOV_SESSION, contact],
    );
    await reagir({ conversation, contact, alvo: sim });

    expect(
      await createPgAdminClient(pool).loadLastInboundBody(GOV_ORG, contact, conversation),
      "o 👍 (body nulo) escondeu o SIM — o match_reply do follow-up não casaria a resposta",
    ).toBe("SIM");
  });
});
