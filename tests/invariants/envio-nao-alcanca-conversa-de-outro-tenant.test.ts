import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * QUEM ENVIA POR TOKEN NÃO ALCANÇA A CONVERSA DA ORGANIZAÇÃO VIZINHA.
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE ═══
 *
 * `sendMessageHandler` é a ÚNICA porta de saída de mensagem do produto, e ela é
 * chamada por caminhos com garantias OPOSTAS:
 *
 *  - pela rota REST com sessão de navegador, o client é o de RLS — a policy de
 *    `conversations` já barra a linha do vizinho, e o handler não precisa fazer
 *    nada;
 *  - pelo servidor MCP (`lib/mcp/server.ts:41`) e pela rota REST autenticada por
 *    `Authorization: Bearer dsk_…` (`lib/api/auth-dual.ts`), o client é
 *    `createAdminClient()` — service-role, que **bypassa RLS**. Aí o ÚNICO
 *    filtro que existe é o que o handler escrever à mão.
 *
 * É o anti-pattern 10 do CLAUDE.md em estado puro. E ele era real: a consulta
 * da conversa filtrava só por `id`. Um chamador de service-role com
 * `organization_id` da org A passava um `conversation_id` da org B e a linha
 * vinha; daí em diante TODO o resto do handler usa `c.organization_id` — a org
 * da VÍTIMA — e a mensagem era inserida e enviada pelo canal dela.
 *
 * ═══ COMO SE MEDE ═══
 *
 * `pgComoSupabase` conecta como `postgres`: NÃO há RLS neste teste. É
 * deliberado — é exatamente assim que o service-role vê o banco, e é o cenário
 * que precisa ser barrado pelo próprio handler. Ler o código não bastaria:
 * `organization_id` aparece dezenas de vezes neste handler sem que nenhuma
 * delas filtre a consulta que importa.
 *
 * O desfecho medido é DUPLO de propósito: a resposta (404) E o estado do banco
 * (nenhuma linha em `messages` na conversa da vítima). Só a resposta deixaria
 * passar um conserto que recusa DEPOIS de gravar.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

/** A organização do token que está agindo. */
const ORG_A = "ce000781-0000-4000-8000-00000000000a";
/** A vítima: outra organização, com a conversa dela. */
const ORG_B = "ce000781-0000-4000-8000-00000000000b";

const CONTATO_B = "ce000781-0000-4000-8000-0000000000b1";
const SESSAO_B = "ce000781-0000-4000-8000-0000000000b2";
const CONVERSA_B = "ce000781-0000-4000-8000-0000000000b3";

const CONTATO_A = "ce000781-0000-4000-8000-0000000000a1";
const SESSAO_A = "ce000781-0000-4000-8000-0000000000a2";
const CONVERSA_A = "ce000781-0000-4000-8000-0000000000a3";

/** O contexto que `resolveAuthDual` monta no ramo do token (`via: "token"`). */
function ctxDoTokenDeA(): HandlerCtx {
  return {
    organization_id: ORG_A,
    actor: { type: "ai_agent", id: "tok-de-a", role: "agent" },
    requestId: "req-781-cross-tenant",
  };
}

function texto(conversationId: string): SendMessageInput {
  return {
    conversation_id: conversationId,
    type: "text",
    body: "mensagem que não deveria sair pelo canal do vizinho",
  } as SendMessageInput;
}

async function semearOrg(
  org: string,
  slug: string,
  ids: { contato: string; sessao: string; conversa: string },
): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Envio Cross LTDA', 'Envio Cross') on conflict (id) do nothing`,
    [org, slug],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead ' || $3, $4) on conflict (id) do nothing`,
    [ids.contato, org, slug, `+55119${org.slice(-8, -1)}`.slice(0, 14)],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [ids.sessao, org, `sessao-${slug}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [ids.conversa, org, ids.contato, ids.sessao],
  );
}

async function mensagensDa(conversa: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from messages where conversation_id = $1",
    [conversa],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  await semearOrg(ORG_A, "envio-cross-a", {
    contato: CONTATO_A,
    sessao: SESSAO_A,
    conversa: CONVERSA_A,
  });
  await semearOrg(ORG_B, "envio-cross-b", {
    contato: CONTATO_B,
    sessao: SESSAO_B,
    conversa: CONVERSA_B,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("a conversa da outra organização", () => {
  it("o cenário está montado — sem isto, o caso principal mede o vazio", async () => {
    const { rows } = await pool.query<{ organization_id: string }>(
      "select organization_id from conversations where id = $1",
      [CONVERSA_B],
    );
    expect(rows[0]?.organization_id).toBe(ORG_B);
    expect(await mensagensDa(CONVERSA_B)).toBe(0);
  });

  it("o INSTRUMENTO enxerga os embeds — sem isto, o caso principal passa por erro de SQL", async () => {
    // `sendMessageHandler` lê a conversa com dois embeds PostgREST-style. Se o
    // adaptador não os traduzisse, TODA chamada morreria num 500 genérico e o
    // ataque "falharia" sem que filtro nenhum tivesse agido.
    const { data, error } = await db
      .from("conversations")
      .select(
        "id, organization_id, contacts:contact_id(phone_number, is_blocked), channel_sessions:channel_session_id(provider, waha_session_name, status)",
      )
      .eq("id", CONVERSA_B)
      .maybeSingle();
    expect(error).toBeNull();
    const linha = data as unknown as {
      contacts: { is_blocked: boolean } | null;
      channel_sessions: { status: string } | null;
    } | null;
    expect(linha?.contacts?.is_blocked).toBe(false);
    expect(linha?.channel_sessions?.status).toBe("WORKING");
  });

  it("o envio pela PRÓPRIA organização funciona — o controle positivo", async () => {
    // Sem este caso, um handler que recusasse TODO envio ficaria verde no caso
    // principal: a ausência de vazamento viria de o produto estar morto.
    const msg = await sendMessageHandler(
      db,
      { ...ctxDoTokenDeA(), organization_id: ORG_A },
      texto(CONVERSA_A),
    );
    expect(msg.id).toBeTruthy();
    expect(await mensagensDa(CONVERSA_A)).toBe(1);
  });

  it("NÃO recebe mensagem de um chamador de service-role de outra org", async () => {
    await expect(sendMessageHandler(db, ctxDoTokenDeA(), texto(CONVERSA_B))).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("e o banco da vítima continua sem a linha — recusar depois de gravar não conta", async () => {
    expect(await mensagensDa(CONVERSA_B)).toBe(0);
  });
});
