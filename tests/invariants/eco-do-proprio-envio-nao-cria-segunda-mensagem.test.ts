/**
 * #1323, parte 2 — o ECO do próprio envio social não pode virar segunda mensagem.
 *
 * O canal Zernio publica também o que SAI por ele: o envio do CRM volta no
 * webhook como `message.sent`, direction `outgoing`, com o MESMO
 * `platformMessageId` que o envio gravou em `messages.external_id`. O que
 * separa "o eco do meu envio" de "alguém respondeu por fora do CRM" é uma
 * colisão só — o unique (`organization_id`, `external_id`) de `messages`:
 *
 *   lado A (o eco)      -> o insert bate no 23505, `insertMessage` devolve
 *                          `duplicate` e o handler SAI antes de pausar a IA.
 *                          Nenhuma segunda mensagem, IA acordada.
 *   lado B (terceiro)   -> `external_id` novo entra como linha nova e a IA é
 *                          pausada por atendimento manual. A thread do B também
 *                          é inédita de propósito: a pausa incondicional para
 *                          qualquer saída está na âncora nova — no ramo de
 *                          thread já conhecida ela exige `socialMessage`.
 *
 * Este arquivo prova as duas pontas CONTRA POSTGRES DE VERDADE (não há mock de
 * banco: é a própria constraint que distingue os casos) e prova a constraint
 * por fora, com INSERT cru. O adapter Zernio é mockado pela única porta que ele
 * usa: `globalThis.fetch` — o `send` do adapter chama `fetch` DIRETO
 * (lib/channels/adapters/zernio.ts), sem passar pelos guardas de outbound, que
 * só existem no caminho de mídia. A rede aqui não é "não aconteceu": é
 * PROIBIDA — o stub lança e conta, e nenhum caso pode incrementar o contador.
 *
 * Referência de estrutura: tests/invariants/envio-nao-alcanca-conversa-de-outro-tenant.test.ts
 */
import { createHmac } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleInboundWebhook } from "@/lib/channels/inbound";

import { pgComoSupabase } from "../pg-como-supabase";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

/** O cliente que a rota monta com service_role (mesma escolha do vizinho). */
const db = pgComoSupabase(pool);

// ─── Fixtures ───────────────────────────────────────────────────────────────
//
// `account.id` é o mesmo do fixture do canal: o ingest compara a conta do
// payload com o `zernio_account_id` da sessão e trata divergência como
// `unknown_account` — o teste passaria a medir a coisa errada.

const ORG = "e2000000-1323-4000-8000-000000000001";
const SESSAO = "e2000000-1323-4000-8000-000000000002";
const CONTA_ZERNIO = "6a3572a15f7d1751ab117832";

/** >= MIN_SECRET_LEN do roteador: segredo curto é recusado antes de tudo. */
const SEGREDO = "segredo-de-teste-do-eco-zernio-1323";

/** Thread que o CRM conhece (a conversa tem `provider_conversation_id`). */
const THREAD_CONHECIDA = "6a76a2dc4b8fe115e5f6c301";
/** Thread que o CRM NÃO conhece: cai na âncora nova (`fn_upsert_wa_conversation`). */
const THREAD_DESCONHECIDA = "6a76a2dc4b8fe115e5f6c399";

/** lado A, thread conhecida. */
const CONTATO_A1 = "e2000000-1323-4000-8000-0000000000a1";
const CONVERSA_A1 = "e2000000-1323-4000-8000-0000000000a2";
const TELEFONE_A1 = "+5511990001323";
const ECO_A1 = "wamid.ECO-A1-PROPRIA";

/** lado A, âncora nova — é aqui que a pausa da IA está 10 linhas abaixo. */
const CONTATO_A2 = "e2000000-1323-4000-8000-0000000000b1";
const CONVERSA_A2 = "e2000000-1323-4000-8000-0000000000b2";
const TELEFONE_A2 = "+5511990001324";
const ECO_A2 = "wamid.ECO-A2-PROPRIA";

/** lado B: saída de terceiro, `external_id` que o banco nunca viu. */
const CONTATO_B = "e2000000-1323-4000-8000-0000000000c1";
const CONVERSA_B = "e2000000-1323-4000-8000-0000000000c2";
const TELEFONE_B = "+5511990001325";
const SAIDA_TERCEIRO = "wamid.SAIDA-DE-TERCEIRO";
/**
 * Thread do lado B — também inédita, e por um motivo: a thread do A2 é GRAVADA
 * na conversa do A2 pelo próprio ingest (coluna `provider_conversation_id`).
 * Reaproveitar a mesma thread aqui faria a saída do B cair na conversa do A2
 * (ramo de thread conhecida) em vez da conversa do B, e o teste passaria a
 * medir outra coisa.
 */
const THREAD_TERCEIRO = "6a76a2dc4b8fe115e5f6c3b7";

/** INSERT cru contra a constraint. */
const CONTATO_CRU = "e2000000-1323-4000-8000-0000000000d1";
const CONVERSA_CRU = "e2000000-1323-4000-8000-0000000000d2";
const EXTERNAL_ID_CRU = "wamid.INSERT-CRU";

const sessao = {
  id: SESSAO,
  organization_id: ORG,
  provider: "zernio",
  display_name: "Canal Zernio (1323)",
  phone_number: "+5511900001323",
};

// ─── A rede é proibida, não só ausente ──────────────────────────────────────

const fetchOriginal = globalThis.fetch;
const chamadasDeRede: string[] = [];
const fetchProibido = (async (entrada: unknown) => {
  chamadasDeRede.push(String(entrada));
  throw new Error("rede proibida neste invariante: adapter Zernio mockado");
}) as unknown as typeof fetch;

// ─── Fixture do evento ──────────────────────────────────────────────────────

function eventoDaPlataforma(
  msg: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  // `participantPhoneNumber` descreve o OUTRO lado (o cliente) e por isso não
  // vai para dentro de `message`: na saída, quem está lá somos nós.
  const { participantPhoneNumber, ...dentroDaMensagem } = msg;

  const message: Record<string, unknown> = {
    id: "m-1323",
    conversationId: THREAD_DESCONHECIDA,
    platform: "whatsapp",
    platformMessageId: "wamid.NAO-USADO",
    direction: "outgoing",
    text: "bom dia! seu pedido saiu para entrega",
    attachments: [],
    sender: { phoneNumber: TELEFONE_A1, name: "Atendimento" },
    sentAt: "2026-08-08T01:00:00.000Z",
    isRead: false,
    ...dentroDaMensagem,
  };

  return {
    id: "evt-1323-eco",
    // O provider publica o que SAI por ele com este nome de evento; o direção
    // é o que o ingest usa para decidir pausar a IA.
    event: "message.sent",
    account: { id: CONTA_ZERNIO },
    // ─── Quem está do OUTRO lado da saída ───────────────────────────────────
    //
    // Numa mensagem de SAÍDA o `sender` somos NÓS (o payload real traz o número
    // da empresa). Por isso `parseZernioInbound` IGNORA o sender nesse caso e lê
    // o cliente de `conversation.participantId` — é lá que o provider entrega o
    // telefone do participante, SEM o "+" (medido: `595985321822`). Um evento de
    // saída sem participante não tem identidade nenhuma, e a ingestão para em
    // `sem_identidade_utilizavel`: foi o que aconteceu com a primeira versão
    // deste arquivo, que trazia só o `sender`.
    conversation: {
      id: String(message.conversationId),
      participantId: String(participantPhoneNumber ?? TELEFONE_A1).replace(/\D/g, ""),
      participantName: "Cliente do outro lado",
    },
    message,
    ...over,
  };
}

/**
 * Entrega o payload pela porta de entrada REAL: `handleInboundWebhook` com
 * assinatura HMAC válida em `x-zernio-signature` (o `secret` chega decifrado
 * pela rota — aqui ele já é a string clara).
 */
async function entregar(payload: unknown): Promise<Desfecho> {
  const rawBody = JSON.stringify(payload);
  const assinatura = createHmac("sha256", SEGREDO).update(rawBody, "utf8").digest("hex");
  const headers = new Headers({ "x-zernio-signature": `sha256=${assinatura}` });
  return handleInboundWebhook(db, {
    session: sessao,
    rawBody,
    headers,
    secret: SEGREDO,
  });
}

type Desfecho = Awaited<ReturnType<typeof handleInboundWebhook>>;

/** `status` do desfecho, ou `erro:<code>` — nunca silencia uma recusa. */
function statusDo(r: Desfecho): string {
  const qualquer = r as { ok?: boolean; code?: string; body?: { status?: unknown } };
  return qualquer.ok ? String(qualquer.body?.status ?? "(sem status)") : `erro:${qualquer.code}`;
}

// ─── Semeadura ──────────────────────────────────────────────────────────────

async function semearOrgEPrecoes(): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'eco-1323', 'Eco do Próprio Envio LTDA', 'Eco 1323')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions
       (id, organization_id, provider, zernio_account_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'zernio', $3, 'sessao-eco-1323', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSAO, ORG, CONTA_ZERNIO],
  );
}

async function semearConversa(
  contato: string,
  conversa: string,
  telefone: string,
  thread: string | null,
): Promise<void> {
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Contato do eco', $3) on conflict (id) do nothing`,
    [contato, ORG, telefone],
  );
  await pool.query(
    `insert into conversations
       (id, organization_id, contact_id, channel_session_id, channel, status, is_group, provider_conversation_id)
     values ($1, $2, $3, $4, 'whatsapp', 'open', false, $5) on conflict (id) do nothing`,
    [conversa, ORG, contato, SESSAO, thread],
  );
}

/**
 * A linha que o NOSSO envio já gravou — as colunas são exatamente as que
 * `insertMessage` usa (lib/channels/zernio/ingest.ts): o eco é reconhecido por
 * (`organization_id`, `external_id`), e `sent_via: 'external_device'` é a marca
 * de saída que o provider publica.
 */
async function semearEnvioNosso(
  conversa: string,
  contato: string,
  externalId: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into messages
       (organization_id, conversation_id, contact_id, channel_session_id, external_id,
        direction, sent_via, status, type, body, metadata, sent_at)
     values ($1, $2, $3, $4, $5, 'outbound', 'external_device', 'sent', 'text',
             'bom dia! seu pedido saiu para entrega', '{}'::jsonb, now() - interval '1 minute')
     returning id`,
    [ORG, conversa, contato, SESSAO, externalId],
  );
  return rows[0]!.id;
}

// ─── Leituras ───────────────────────────────────────────────────────────────

async function contarPorExternalId(externalId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from messages where organization_id = $1 and external_id = $2",
    [ORG, externalId],
  );
  return Number(rows[0]!.n);
}

async function contarNaConversa(conversa: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from messages where conversation_id = $1",
    [conversa],
  );
  return Number(rows[0]!.n);
}

async function totalDeMensagens(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from messages where organization_id = $1",
    [ORG],
  );
  return Number(rows[0]!.n);
}

/** Conversas da organização com a IA calada AGORA (a pausa que o lado B faz). */
async function pausadas(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from conversations
      where organization_id = $1 and bot_silenced_until is not null and bot_silenced_until > now()
      order by id`,
    [ORG],
  );
  return rows.map((r) => r.id);
}

async function pausadasDeFuturo(): Promise<{ id: string; last_handoff_reason: string | null }[]> {
  const { rows } = await pool.query<{ id: string; last_handoff_reason: string | null }>(
    `select id, last_handoff_reason from conversations
      where organization_id = $1 and bot_silenced_until is not null and bot_silenced_until > now()
      order by id`,
    [ORG],
  );
  return rows;
}

function novas(antes: string[], depois: string[]): string[] {
  return depois.filter((id) => !antes.includes(id));
}

beforeAll(async () => {
  globalThis.fetch = fetchProibido;
  // Credencial presente de propósito: se algum caminho tentasse enviar, ele
  // CHEGARIA no fetch (e não sairia por "canal não conectado"), bateria no stub
  // e o contador denunciaria. Ausente, o mesmo defeito passaria despercebido.
  process.env.ZERNIO_API_KEY ??= "chave-de-teste-nunca-usada";
  process.env.ZERNIO_ACCOUNT_ID ??= CONTA_ZERNIO;
  process.env.ZERNIO_API_BASE_URL ??= "https://zernio.invalid/api";

  await pool.query("select 1");
  await semearOrgEPrecoes();
  await semearConversa(CONTATO_A1, CONVERSA_A1, TELEFONE_A1, THREAD_CONHECIDA);
  await semearConversa(CONTATO_A2, CONVERSA_A2, TELEFONE_A2, null);
  await semearConversa(CONTATO_B, CONVERSA_B, TELEFONE_B, null);
  await semearConversa(CONTATO_CRU, CONVERSA_CRU, "+5511990001326", null);
});

afterAll(async () => {
  globalThis.fetch = fetchOriginal;
  await pool.end();
});

describe("eco do próprio envio social (Zernio) — #1323 parte 2", () => {
  it("lado A: o eco não cria segunda mensagem nem pausa a IA (thread conhecida)", async () => {
    const linha = await semearEnvioNosso(CONVERSA_A1, CONTATO_A1, ECO_A1);
    expect(linha).toBeTruthy();

    const pausadasAntes = await pausadas();
    const totalAntes = await totalDeMensagens();

    const desfecho = await entregar(
      eventoDaPlataforma({
        conversationId: THREAD_CONHECIDA,
        platformMessageId: ECO_A1,
        sender: { phoneNumber: TELEFONE_A1, name: "Atendimento" },
        participantPhoneNumber: TELEFONE_A1,
      }),
    );

    // O eco é reconhecido como duplicata: não é erro, é absorção.
    expect(statusDo(desfecho)).toBe("duplicate");

    // NEM SEGUNDA MENSAGEM: a linha do envio continua sendo uma só.
    expect(await contarPorExternalId(ECO_A1)).toBe(1);
    expect(await contarNaConversa(CONVERSA_A1)).toBe(1);
    expect(await totalDeMensagens()).toBe(totalAntes);

    // NEM IA PAUSADA.
    expect(novas(pausadasAntes, await pausadas())).toEqual([]);

    // E a rede ficou intocada, apesar de haver credencial configurada.
    expect(chamadasDeRede).toEqual([]);
  });

  it("lado A: o eco que cai na âncora nova também é absorvido, sem pausar a IA", async () => {
    // A conversa NÃO conhece a thread do evento: o fluxo percorre a âncora nova
    // (contato -> fn_upsert_wa_conversation -> insert) e é lá que a pausa da IA
    // fica logo ABAIXO do teste de duplicidade. É o caso que a sabotagem derruba.
    await semearEnvioNosso(CONVERSA_A2, CONTATO_A2, ECO_A2);

    const pausadasAntes = await pausadas();
    const totalAntes = await totalDeMensagens();

    const desfecho = await entregar(
      eventoDaPlataforma({
        conversationId: THREAD_DESCONHECIDA,
        platformMessageId: ECO_A2,
        sender: { phoneNumber: TELEFONE_A2, name: "Atendimento" },
        participantPhoneNumber: TELEFONE_A2,
      }),
    );

    expect(statusDo(desfecho)).toBe("duplicate");
    expect(await contarPorExternalId(ECO_A2)).toBe(1);
    expect(await contarNaConversa(CONVERSA_A2)).toBe(1);
    expect(await totalDeMensagens()).toBe(totalAntes);
    expect(novas(pausadasAntes, await pausadas())).toEqual([]);
    expect(chamadasDeRede).toEqual([]);
  });

  it("lado B: saída de terceiro com external_id e thread inéditos entra e PAUSA a IA", async () => {
    const pausadasAntes = await pausadas();
    const totalAntes = await totalDeMensagens();

    const desfecho = await entregar(
      eventoDaPlataforma({
        conversationId: THREAD_TERCEIRO,
        platformMessageId: SAIDA_TERCEIRO,
        text: "oi, sou eu aqui no celular do escritório",
        sender: { phoneNumber: TELEFONE_B, name: "Atendimento" },
        participantPhoneNumber: TELEFONE_B,
      }),
    );

    // Sem colisão, a saída entra como linha nova — o CRM passa a saber que
    // alguém respondeu por fora dele.
    expect(statusDo(desfecho)).toBe("ingested");
    expect(await contarPorExternalId(SAIDA_TERCEIRO)).toBe(1);
    expect(await totalDeMensagens()).toBe(totalAntes + 1);

    // Onde a saída caiu? O CRM tem que saber para exigir que a pausa seja
    // DAQUELA conversa — pausa é por conversa, não por organização.
    const { rows: destinoRows } = await pool.query<{ conversation_id: string }>(
      "select conversation_id from messages where organization_id = $1 and external_id = $2",
      [ORG, SAIDA_TERCEIRO],
    );
    expect(destinoRows).toHaveLength(1);
    const destino = destinoRows[0]!.conversation_id;
    expect(destino).toBe(CONVERSA_B);

    // E a IA é calada nessa conversa — não em qualquer conversa da organização.
    const pausadasDepois = await pausadas();
    expect(novas(pausadasAntes, pausadasDepois)).toContain(destino);

    // Prova direta no banco: a conversa ficou com a IA pausada até um instante
    // no futuro, com motivo registrado.
    const { rows: pausa } = await pool.query<{
      bot_silenced_until: string | null;
      last_handoff_reason: string | null;
    }>("select bot_silenced_until, last_handoff_reason from conversations where id = $1", [
      destino,
    ]);
    expect(pausa[0]!.bot_silenced_until).not.toBeNull();
    expect(new Date(pausa[0]!.bot_silenced_until as string).getTime()).toBeGreaterThan(Date.now());
    expect(pausa[0]!.last_handoff_reason).not.toBeNull();

    const comMotivo = await pausadasDeFuturo();
    expect(comMotivo.length).toBeGreaterThan(0);
    expect(comMotivo.every((c) => c.last_handoff_reason !== null)).toBe(true);

    expect(chamadasDeRede).toEqual([]);
  });

  it("INSERT cru com o mesmo external_id bate na messages_org_external_id_unique", async () => {
    const colunas = `(organization_id, conversation_id, contact_id, channel_session_id, external_id,
                      direction, sent_via, status, type, body, metadata, sent_at)`;
    const valores = `($1, $2, $3, $4, $5, 'outbound', 'external_device', 'sent', 'text',
                      'linha crua', '{}'::jsonb, now())`;

    const primeira = await pool.query(
      `insert into messages ${colunas} values ${valores}`,
      [ORG, CONVERSA_CRU, CONTATO_CRU, SESSAO, EXTERNAL_ID_CRU],
    );
    expect(primeira.rowCount).toBe(1);

    // A constraint é DEFERRABLE INITIALLY DEFERRED: a violação é acusada no
    // COMMIT, não no INSERT. Por isso a segunda tentativa vai numa transação
    // explícita — e o rollback garante que nada fica pendurado.
    const cliente = await pool.connect();
    let erro: { code?: string; constraint?: string; message?: string } | null = null;
    try {
      await cliente.query("begin");
      await cliente.query(`insert into messages ${colunas} values ${valores}`, [
        ORG,
        CONVERSA_CRU,
        CONTATO_CRU,
        SESSAO,
        EXTERNAL_ID_CRU,
      ]);
      await cliente.query("commit");
    } catch (e) {
      erro = e as { code?: string; constraint?: string; message?: string };
    } finally {
      await cliente.query("rollback").catch(() => undefined);
      cliente.release();
    }

    expect(erro?.code).toBe("23505");
    expect(erro?.constraint ?? erro?.message ?? "").toContain("messages_org_external_id_unique");

    // E o banco continua com UMA linha: a recusa não deixou rastro.
    expect(await contarPorExternalId(EXTERNAL_ID_CRU)).toBe(1);
  });

  it("o caminho inteiro não toca a rede (adapter Zernio mockado)", () => {
    // O `send` do adapter Zernio chama `fetch` direto (não passa pelos guardas
    // de outbound, que só existem na mídia): substituir o global é o mock
    // completo daquele caminho. Se o global não fosse o nosso stub, um envio de
    // verdade sairia — por isso a identidade é conferida, e não só o contador.
    expect(globalThis.fetch).toBe(fetchProibido);
    expect(chamadasDeRede).toEqual([]);
  });
});
