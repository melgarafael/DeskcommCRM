import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { Message } from "@/lib/types/messaging";

/**
 * O CORPO DA APAGADA PELO CONTATO NÃO VIAJA NA CONVERSA (#4500).
 *
 * ─── O defeito medido, e é o RED desta entrega ─────────────────────────────
 *
 * `MSG_COLS` inclui `body` e o handler não filtrava nada: a mensagem que o
 * contato apagou chegava inteira no JSON de
 * `GET /api/v1/conversations/[id]/messages` — e de lá também no histórico lido
 * pelo MCP, com service role. O balão escondia (`textoDaApagadaApareceNaInbox`),
 * o payload entregava. Esconder na tela não é o mesmo que não entregar.
 *
 * ─── O que passa a valer ───────────────────────────────────────────────────
 *
 *   • apagada pelo CONTATO  → `body: null`, `media_derived_text: null` e
 *     `texto_retido: true` (o sinal que liga o botão, sem conteúdo);
 *   • apagada pelo ATENDENTE → corpo intacto (a régua do balão não muda);
 *   • mensagem viva          → intacta.
 *
 * O duplo é mínimo e em memória: o alvo aqui é o PAYLOAD, não a paginação (que
 * tem invariante própria, contra Postgres de verdade).
 */

const CONV = "conv-1";
const CTX = {
  organization_id: "org-1",
  actor: { type: "user", id: "usuario-1" },
  requestId: "req-1",
} as unknown as HandlerCtx;

/** Texto FICTÍCIO — nenhum conteúdo real de cliente entra em teste. */
const TEXTO_FICTICIO = "combinado fictício de teste, 3 caixas";

function cliente(linhas: Array<Partial<Message>>): SupabaseClient {
  const tabela = (nome: string) => {
    const q: Record<string, unknown> = {};
    const devolve = () =>
      nome === "messages"
        ? linhas
        : nome === "conversations"
          ? [{ contact_id: "contato-1" }]
          : [{ is_personal: false }];
    for (const metodo of ["select", "eq", "order", "limit", "or"]) {
      q[metodo] = () => q;
    }
    q.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve({ data: devolve(), error: null }).then(ok, falha);
    return q;
  };
  return { from: tabela } as unknown as SupabaseClient;
}

function mensagem(over: Partial<Message>): Message {
  return {
    id: "msg-1",
    organization_id: "org-1",
    conversation_id: CONV,
    channel_session_id: "sessao-1",
    contact_id: "contato-1",
    external_id: "ABC",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: 1,
    error_code: null,
    error_message: null,
    body: TEXTO_FICTICIO,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: "2026-11-10T12:00:00.000Z",
    delivered_at: "2026-11-10T12:00:01.000Z",
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-11-10T12:00:00.000Z",
    ...over,
  };
}

describe("apagada pelo contato não entrega o corpo", () => {
  it("body sai nulo, o sinal de texto retido fica, e o JSON não tem uma vírgula do texto", async () => {
    const apagada = mensagem({ revoked_at: "2026-11-10T12:05:00.000Z" });

    const r = await listMessagesHandler(cliente([apagada]), CTX, CONV, { limit: 50 });

    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.body).toBeNull();
    expect(r.messages[0]!.texto_retido).toBe(true);
    expect(JSON.stringify(r)).not.toContain("combinado fictício");
  });

  it("a transcrição da mídia apagada também não sai", async () => {
    const apagada = mensagem({
      type: "audio",
      body: null,
      media_derived_text: "transcrição fictícia do áudio apagado",
      revoked_at: "2026-11-10T12:05:00.000Z",
    });

    const r = await listMessagesHandler(cliente([apagada]), CTX, CONV, { limit: 50 });

    expect(r.messages[0]!.media_derived_text).toBeNull();
    expect(JSON.stringify(r)).not.toContain("transcrição fictícia");
  });
});

describe("as outras linhas continuam como estavam", () => {
  it("apagada pelo ATENDENTE mantém o corpo — a equipe segue vendo", async () => {
    const apagadaPeloAtendente = mensagem({
      direction: "outbound",
      sent_via: "user",
      revoked_at: "2026-11-10T12:05:00.000Z",
    });

    const r = await listMessagesHandler(cliente([apagadaPeloAtendente]), CTX, CONV, { limit: 50 });

    expect(r.messages[0]!.body).toBe(TEXTO_FICTICIO);
    expect(r.messages[0]!.texto_retido).toBeUndefined();
  });

  it("mensagem viva mantém o corpo", async () => {
    const viva = mensagem({});

    const r = await listMessagesHandler(cliente([viva]), CTX, CONV, { limit: 50 });

    expect(r.messages[0]!.body).toBe(TEXTO_FICTICIO);
  });
});
