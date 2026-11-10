import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A MENSAGEM DO HISTÓRICO IMPORTADO NÃO DISPARA NADA (#999).
 *
 * O importador de histórico do WhatsApp grava em `messages` conversas que
 * aconteceram meses atrás, marcadas com `metadata.historico_importado = 'true'`
 * (contrato já escrito no cabeçalho da migration 0686). Se a linha atravessar os
 * gatilhos de INSERT como mensagem recebida, o passado vira atendimento de
 * agora:
 *
 *   * `trg_demanda_abre_no_inbound` → `fn_service_inbound` REABRE a conversa
 *     encerrada e abre demanda/SLA para uma fala antiga;
 *   * `trg_messages_emit_event` → `message.received`, que acorda a IA, a push,
 *     o webhook de saída, a campanha e o follow-up — a IA RESPONDERIA gente que
 *     falou há meses;
 *   * `trg_reply_inbound_revision` → +1 na revisão de contexto.
 *
 * A cura (migration 0723) é o mesmo corte da reação (0684): a linha continua
 * gravada, só não conta como fala. E a conversa que o importador cria nasce
 * `closed`, sem dono, pela `fn_upsert_wa_conversation_importada` — sem
 * `conversation.routing_requested`.
 *
 * O controle (a mesma mensagem SEM a chave ainda emite `message.received` e
 * reabre) existe para o "não dispara" não ficar verde à toa.
 *
 * O Foco 1 (o upsert do contato dispara algo?) é MEDIÇÃO: o teste registra
 * quantas linhas de `event_log` e de `crm_leads` nascem de um contato novo por
 * `fn_upsert_wa_contact`, e cobra zero — se um dia nascer, o importador passa a
 * acordar alguém ao trazer o contato, e este arquivo é quem avisa.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

beforeAll(() => seedGov());
afterAll(async () => pool.end());

const IMPORTADA = { historico_importado: "true" };

async function novoContato(nome = "Histórico") {
  const contact = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
    contact,
    GOV_ORG,
    nome,
  ]);
  return contact;
}

/** Conversa com uma fala real e ENCERRADA — o estado em que o passado reabriria. */
async function conversaEncerrada() {
  const contact = await novoContato();
  const conversation = randomUUID();
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  await pool.query(
    `insert into messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text','inbound','received','ai','Oi',clock_timestamp())`,
    [randomUUID(), GOV_ORG, conversation, GOV_SESSION, contact],
  );
  await pool.query("select * from fn_service_status($1,$2,'closed',null)", [GOV_ORG, conversation]);
  return { contact, conversation };
}

/**
 * `sent_at` é o AGORA de propósito: `fn_service_inbound` já não reabre por
 * mensagem com `sent_at <= service_closed_at`, então uma data antiga deixaria o
 * "não reabre" verde sem o corte. O histórico importado também traz a conversa
 * de ontem — depois do encerramento —, e é esse caso que o corte tem de segurar.
 */
async function gravar(args: {
  conversation: string;
  contact: string;
  direction?: "inbound" | "outbound";
  metadata?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const direction = args.direction ?? "inbound";
  await pool.query(
    `insert into messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,sent_via,body,sent_at,metadata)
     values($1,$2,$3,$4,$5,$6,'text',$7,$8,$9,'Mensagem do histórico',clock_timestamp(),$10::jsonb)`,
    [
      id,
      GOV_ORG,
      args.conversation,
      GOV_SESSION,
      args.contact,
      `hist-${id}`,
      direction,
      direction === "inbound" ? "received" : "sent",
      direction === "inbound" ? "ai" : "external_device",
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  return id;
}

async function estado(conversation: string) {
  const { rows } = await pool.query(
    "select status, reply_context_revision, assigned_to_user_id from conversations where id=$1 and organization_id=$2",
    [conversation, GOV_ORG],
  );
  return rows[0] as {
    status: string;
    reply_context_revision: number;
    assigned_to_user_id: string | null;
  };
}

async function eventosDaOrg(): Promise<number> {
  const { rows } = await pool.query(
    "select count(*)::int as n from event_log where organization_id=$1",
    [GOV_ORG],
  );
  return rows[0].n as number;
}

async function eventosDa(entityId: string): Promise<string[]> {
  const { rows } = await pool.query(
    "select event_type from event_log where organization_id=$1 and entity_id=$2 order by event_type",
    [GOV_ORG, entityId],
  );
  return rows.map((r) => r.event_type as string);
}

async function demandasDo(contact: string): Promise<number> {
  const { rows } = await pool.query(
    "select count(*)::int as n from demandas where organization_id=$1 and contact_id=$2",
    [GOV_ORG, contact],
  );
  return rows[0].n as number;
}

describe("a mensagem do histórico importado não dispara gatilho", () => {
  it("entrada importada: 0 eventos, 0 demandas, revisão igual, conversa fechada continua fechada", async () => {
    const { contact, conversation } = await conversaEncerrada();
    const antes = await estado(conversation);
    expect(antes.status, "pré-condição: a conversa começa fechada").toBe("closed");
    const eventosAntes = await eventosDaOrg();
    const demandasAntes = await demandasDo(contact);

    const msg = await gravar({ conversation, contact, metadata: IMPORTADA });

    const depois = await estado(conversation);
    expect(
      await eventosDa(msg),
      "a mensagem importada emitiu evento — a IA responderia o passado",
    ).toEqual([]);
    expect(await eventosDaOrg(), "nasceu linha em event_log por causa da mensagem importada").toBe(
      eventosAntes,
    );
    expect(await demandasDo(contact), "a mensagem importada abriu demanda").toBe(demandasAntes);
    expect(depois.reply_context_revision, "a mensagem importada mexeu na revisão de contexto").toBe(
      antes.reply_context_revision,
    );
    expect(depois.status, "a mensagem importada REABRIU a conversa fechada").toBe("closed");
  });

  it("a linha importada continua gravada, sem `service_revision`", async () => {
    const { contact, conversation } = await conversaEncerrada();
    const msg = await gravar({ conversation, contact, metadata: IMPORTADA });
    const { rows } = await pool.query(
      "select direction, service_revision, metadata->>'historico_importado' as h from messages where id=$1",
      [msg],
    );
    expect(rows, "o corte não pode recusar a escrita").toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "inbound", service_revision: null, h: "true" });
  });

  it("saída importada também não emite evento", async () => {
    const { contact, conversation } = await conversaEncerrada();
    const msg = await gravar({ conversation, contact, direction: "outbound", metadata: IMPORTADA });
    expect(await eventosDa(msg), "a saída importada emitiu `message.*`").toEqual([]);
  });

  it("controle: a MESMA mensagem sem a chave emite 1 `message.received` e reabre", async () => {
    const { contact, conversation } = await conversaEncerrada();
    const msg = await gravar({ conversation, contact });
    expect(
      await eventosDa(msg),
      "o corte passou do ponto: a mensagem normal não emitiu evento",
    ).toEqual(["message.received"]);
    expect(
      (await estado(conversation)).status,
      "o corte passou do ponto: a mensagem normal não reabriu",
    ).toBe("open");
  });

  it("controle: `historico_importado` diferente de 'true' não corta", async () => {
    const { contact, conversation } = await conversaEncerrada();
    const msg = await gravar({ conversation, contact, metadata: { historico_importado: "false" } });
    expect(await eventosDa(msg)).toEqual(["message.received"]);
  });
});

/** A última mensagem que o canal diz ter na conversa (`conversa.ultimaEm`). */
const ULTIMA_DO_CANAL = "2026-08-14T13:05:00.000Z";

async function ultimaDa(conversation: string) {
  const { rows } = await pool.query(
    "select last_message_at from conversations where id=$1 and organization_id=$2",
    [conversation, GOV_ORG],
  );
  const v = rows[0]?.last_message_at as Date | null | undefined;
  return { last_message_at: v ? v.toISOString() : null };
}

describe("fn_upsert_wa_conversation_importada", () => {
  it("conversa NOVA nasce com `last_message_at` do canal, para a inbox ordená-la pela data", async () => {
    const contact = await novoContato();
    const { rows } = await pool.query(
      "select public.fn_upsert_wa_conversation_importada($1,$2,$3,$4) as id",
      [GOV_ORG, contact, GOV_SESSION, ULTIMA_DO_CANAL],
    );
    expect(await ultimaDa(rows[0].id as string)).toEqual({ last_message_at: ULTIMA_DO_CANAL });
  });

  it("conversa EXISTENTE não muda: nem `last_message_at` nem `updated_at`", async () => {
    const contact = await novoContato();
    const existente = randomUUID();
    await pool.query(
      `insert into conversations(id,organization_id,contact_id,channel_session_id,status,last_message_at,updated_at)
       values($1,$2,$3,$4,'open','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z')`,
      [existente, GOV_ORG, contact, GOV_SESSION],
    );
    const antes = await pool.query("select last_message_at, updated_at from conversations where id=$1", [existente]);

    const { rows } = await pool.query(
      "select public.fn_upsert_wa_conversation_importada($1,$2,$3,$4) as id",
      [GOV_ORG, contact, GOV_SESSION, ULTIMA_DO_CANAL],
    );

    expect(rows[0].id).toBe(existente);
    const depois = await pool.query("select last_message_at, updated_at from conversations where id=$1", [existente]);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  it("sem data do canal (`null`): conversa nova nasce sem `last_message_at`, como antes", async () => {
    const contact = await novoContato();
    const { rows } = await pool.query(
      "select public.fn_upsert_wa_conversation_importada($1,$2,$3,$4) as id",
      [GOV_ORG, contact, GOV_SESSION, null],
    );
    expect(await ultimaDa(rows[0].id as string)).toEqual({ last_message_at: null });
  });

  it("contato sem conversa: cria `closed`, sem dono, sem `conversation.routing_requested`", async () => {
    const contact = await novoContato();
    const eventosAntes = await eventosDaOrg();

    const { rows } = await pool.query(
      "select public.fn_upsert_wa_conversation_importada($1,$2,$3,$4) as id",
      [GOV_ORG, contact, GOV_SESSION, ULTIMA_DO_CANAL],
    );
    const conv = rows[0].id as string;

    expect(conv).toBeTruthy();
    const e = await estado(conv);
    expect(e.status).toBe("closed");
    expect(e.assigned_to_user_id).toBeNull();
    expect(await eventosDa(conv), "a conversa importada entrou na fila do roteamento").toEqual([]);
    expect(await eventosDaOrg(), "a criação da conversa importada gravou evento").toBe(
      eventosAntes,
    );
  });

  it("contato com conversa `open`: devolve a mesma, status inalterado", async () => {
    const contact = await novoContato();
    const aberta = randomUUID();
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
      [aberta, GOV_ORG, contact, GOV_SESSION],
    );
    const antes = await estado(aberta);

    const { rows } = await pool.query(
      "select public.fn_upsert_wa_conversation_importada($1,$2,$3,$4) as id",
      [GOV_ORG, contact, GOV_SESSION, ULTIMA_DO_CANAL],
    );

    expect(rows[0].id).toBe(aberta);
    const depois = await estado(aberta);
    expect(depois.status).toBe("open");
    expect(depois.reply_context_revision).toBe(antes.reply_context_revision);
  });

  it("chamada repetida é idempotente: mesma conversa, continua `closed`", async () => {
    const contact = await novoContato();
    const q = "select public.fn_upsert_wa_conversation_importada($1,$2,$3,$4) as id";
    const a = (await pool.query(q, [GOV_ORG, contact, GOV_SESSION, ULTIMA_DO_CANAL])).rows[0].id as string;
    const b = (await pool.query(q, [GOV_ORG, contact, GOV_SESSION, new Date().toISOString()])).rows[0].id as string;
    expect(b).toBe(a);
    expect((await estado(a)).status).toBe("closed");
    // A segunda chamada achou a conversa: a data dela não muda.
    expect(await ultimaDa(a)).toEqual({ last_message_at: new Date(ULTIMA_DO_CANAL).toISOString() });
  });

  it("permissão igual à da irmã: só service_role executa", async () => {
    const { rows } = await pool.query(
      `select r.rolname,
              has_function_privilege(r.rolname, 'public.fn_upsert_wa_conversation_importada(uuid,uuid,uuid,timestamptz)', 'execute') as nova,
              has_function_privilege(r.rolname, 'public.fn_upsert_wa_conversation(uuid,uuid,uuid)', 'execute') as irma
         from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by r.rolname`,
    );
    for (const r of rows) expect(r.nova, `privilégio de ${r.rolname} difere da irmã`).toBe(r.irma);
    expect(rows.find((r) => r.rolname === "service_role")?.nova).toBe(true);
  });
});

describe("Foco 1 — o upsert do contato dispara algo?", () => {
  it("contato novo por fn_upsert_wa_contact: 0 linhas em event_log, 0 em crm_leads", async () => {
    const eventosAntes = await eventosDaOrg();
    const fone = `+55119${String(Date.now()).slice(-8)}`;

    const { rows } = await pool.query(
      "select public.fn_upsert_wa_contact($1,'phone',$2,null,null,'Fulano') as id",
      [GOV_ORG, fone],
    );
    const contact = rows[0].id as string;
    expect(contact).toBeTruthy();

    const eventosDepois = await eventosDaOrg();
    const leads = await pool.query(
      "select count(*)::int as n from crm_leads where organization_id=$1 and contact_id=$2",
      [GOV_ORG, contact],
    );
    // Medição registrada na saída, para o relatório da tarefa.
    console.info(
      `[foco-1] event_log novos=${eventosDepois - eventosAntes} crm_leads do contato=${leads.rows[0].n} eventos do contato=${JSON.stringify(await eventosDa(contact))}`,
    );
    expect(eventosDepois - eventosAntes, "o upsert do contato gravou evento").toBe(0);
    expect(leads.rows[0].n, "o upsert do contato criou negócio").toBe(0);
  });
});
