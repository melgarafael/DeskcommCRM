/**
 * A prévia da lista da Inbox nos três caminhos do CRM que NÃO são a ingestão
 * (issue #2742, PR #2850).
 *
 * A ingestão passou a gravar "Imagem", "Áudio"… em vez de `[image]`, `[audio]`.
 * Três lugares do CRM também montam essa prévia, e precisam andar juntos:
 *
 * - o envio pela tela (`previewFrom`), que grava a prévia da mídia enviada;
 * - ocultar/restaurar mensagem e apagar mensagem enviada, que só trocam a
 *   prévia se ela ainda for a desta mensagem (compare-and-set em
 *   `last_message_preview`). Se a régua do filtro divergir da que gravou, o
 *   filtro não acha nada, a rota responde 200 e a lista continua mostrando
 *   "Imagem" para uma mensagem ocultada ou apagada. Nenhum erro em lugar nenhum.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { previewFrom } from "@/app/api/v1/messages/_handler";
import { POST as ocultar, DELETE as restaurar } from "@/app/api/v1/messages/[id]/hide/route";
import { DELETE as apagar } from "@/app/api/v1/messages/[id]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "55555555-5555-4555-8555-555555555555", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "id, provider",
  transportaMensagem: () => true,
  resolveSessionRef: () => ({ id: "sessao" }),
  getAdapter: () => ({
    editMessage: vi.fn(async () => undefined),
    revokeMessage: vi.fn(async () => undefined),
    isConfigured: () => true,
    resolveRecipient: () => "5531999998888@c.us",
  }),
}));

/** O que a rota escreveu em `conversations`, com os filtros do compare-and-set. */
let escritas: { payload: unknown; filtros: [string, unknown][] }[] = [];
let mensagem: Record<string, unknown> = {};

function consulta(tabela: string) {
  let op = "select";
  let payload: unknown;
  const filtros: [string, unknown][] = [];
  const linha = (): unknown => {
    if (tabela === "messages") return op === "update" ? { id: MSG } : mensagem;
    if (tabela === "conversations") return { id: CONV, contact_id: "c", is_group: false, channel_session_id: SESSION };
    if (tabela === "channel_sessions") return { id: SESSION, provider: "waha", archived_at: null };
    return { phone_number: "+5531999998888", wa_identity: null, wa_lid: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    order: () => q,
    limit: () => q,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    },
    update: (p: unknown) => {
      op = "update";
      payload = p;
      if (tabela === "conversations") escritas.push({ payload, filtros });
      return q;
    },
    // `latest` (última mensagem da conversa) também cai aqui e devolve o id MSG.
    maybeSingle: async () => ({ data: linha(), error: null }),
    then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => consulta(t) }),
}));

const pedido = (metodo: string) =>
  new NextRequest(`https://crm.exemplo/api/v1/messages/${MSG}`, { method: metodo });
const params = { params: Promise.resolve({ id: MSG }) };

beforeEach(() => {
  escritas = [];
});

describe("envio pelo CRM grava a mesma prévia que a ingestão", () => {
  it("imagem sem legenda vira 'Imagem', não `[image]`", () => {
    expect(previewFrom({ type: "image", media_storage_path: "org/x.jpg" })).toBe("Imagem");
  });

  it("imagem com legenda mostra a legenda", () => {
    expect(previewFrom({ type: "image", media_url: "https://x/y.jpg", body: "olha a foto" })).toBe("olha a foto");
  });

  it("sem corpo e sem mídia, não há prévia", () => {
    expect(previewFrom({ type: "image" })).toBe("");
  });
});

describe("ocultar e restaurar casam a prévia que a ingestão gravou", () => {
  beforeEach(() => {
    mensagem = {
      id: MSG, organization_id: ORG, conversation_id: CONV, direction: "inbound",
      body: null, type: "image", metadata: {}, revoked_at: null,
    };
  });

  it("ocultar imagem recebida sem legenda procura 'Imagem' na lista", async () => {
    const r = await ocultar(pedido("POST"), params);
    expect(r.status).toBe(200);
    const w = escritas.at(-1);
    expect(w?.payload).toEqual({ last_message_preview: "Mensagem ocultada no CRM" });
    expect(w?.filtros).toContainEqual(["last_message_preview", "Imagem"]);
  });

  it("restaurar devolve 'Imagem' à lista, nunca `[image]`", async () => {
    const r = await restaurar(pedido("DELETE"), params);
    expect(r.status).toBe(200);
    const w = escritas.at(-1);
    expect(w?.payload).toEqual({ last_message_preview: "Imagem" });
    expect(w?.filtros).toContainEqual(["last_message_preview", "Mensagem ocultada no CRM"]);
  });
});

describe("apagar casa a prévia que o envio pelo CRM gravou", () => {
  it("apagar imagem enviada sem legenda procura a prévia de `previewFrom`", async () => {
    mensagem = {
      id: MSG, organization_id: ORG, conversation_id: CONV, channel_session_id: SESSION,
      external_id: "true_x@c.us_ABC", direction: "outbound", type: "image", status: "sent",
      body: null, sent_via: "user", sent_by_user_id: USER, sent_at: new Date().toISOString(),
      revoked_at: null,
    };
    const r = await apagar(pedido("DELETE"), params);
    expect(r.status).toBe(200);
    const w = escritas.at(-1);
    expect(w?.payload).toEqual({ last_message_preview: "Esta mensagem foi apagada" });
    const gravada = previewFrom({ type: "image", media_storage_path: "org/x.jpg" });
    expect(w?.filtros).toContainEqual(["last_message_preview", gravada]);
    expect(gravada).toBe("Imagem");
  });
});
