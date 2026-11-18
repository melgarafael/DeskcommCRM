/**
 * O DOCUMENTO REENVIADO SAI COM O NOME ORIGINAL (#4457).
 *
 * O envio pelo Inbox (#4484) e o encaminhamento (#4794) já levam o nome que a
 * pessoa deu ao arquivo. Faltavam os dois caminhos que mandam DE NOVO a mesma
 * linha: o botão de repetir envio que falhou (`POST /messages/{id}/retry`) e a
 * nova tentativa automática depois que o canal pediu para desacelerar
 * (`tratarReenvioDesacelerado`). Os dois reconstroem o envio a partir da linha,
 * leem o `metadata` dela e não passavam `media_filename`: o cliente recebia o
 * documento com o nome do objeto no bucket, `out-<uuid>.pdf`.
 *
 * O handler de envio aqui é o REAL, com o dublê de banco compartilhado, e o que
 * se mede é o nome no corpo do `sendFile` do WAHA — o que o cliente vê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const MENSAGEM = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const USUARIO = "77777777-7777-4777-8777-777777777777";
const WAHA_BASE = "http://localhost:3030";

const VOUCHER = "Dom Travel - Voucher LOC XXXXXX - Nome do Passageiro - Maceió.pdf";
const OBJETO = `${ORG}/${CONV}/out-3f9a2b.pdf`;

// O cliente do banco da rota é trocado por teste: cada caso monta o seu dublê.
const estado = vi.hoisted(() => ({ banco: null as unknown }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "77777777-7777-4777-8777-777777777777", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "agent" },
  }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, limit: 20, count: 1, window_sec: 60 }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => estado.banco }));
// A assinatura do objeto sai pelo admin client, que valida env no import.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://storage.example/sign/out-3f9a2b.pdf" },
          error: null,
        }),
      }),
    },
  }),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { POST } from "@/app/api/v1/messages/[id]/retry/route";
import { ESPERA_PADRAO_MS, tratarReenvioDesacelerado } from "@/lib/messaging/reenvio-desacelerado.handler";
import { EVENTO_REENVIO_DESACELERADO } from "@/lib/messaging/reenvio-desacelerado";

/** A conversa WAHA que o envio lê — a mesma do teste do encaminhamento. */
function conversaRow() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTATO,
    channel_session_id: SESSAO,
    is_group: false,
    group_chat_id: null,
    contacts: { phone_number: "+553****8888", wa_identity: null, is_blocked: false },
    channel_sessions: {
      provider: "waha",
      waha_session_name: "default",
      status: "WORKING",
      archived_at: null,
    },
  };
}

/** O documento que a pessoa mandou pelo Inbox: objeto `out-<uuid>.pdf`, nome no `metadata`. */
function documentoEnviado(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MENSAGEM,
    organization_id: ORG,
    conversation_id: CONV,
    contact_id: CONTATO,
    external_id: null,
    direction: "outbound",
    type: "document",
    body: null,
    media_url: null,
    media_storage_path: OBJETO,
    media_mime: "application/pdf",
    media_size_bytes: 1024,
    reply_to_message_id: null,
    sent_via: "user",
    sent_by_user_id: USUARIO,
    sent_at: "2026-11-17T10:00:00.000Z",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:00:00.123456+00:00",
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
  vi.stubEnv("WAHA_API_KEY", "hash123");
  fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ id: { _serialized: "DOC1" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** O nome do documento no corpo do `sendFile` do WAHA: o que o cliente vê no WhatsApp. */
function nomeNoWhatsApp(): string | undefined {
  const envio = fetchMock.mock.calls.find(([url]) => String(url) === `${WAHA_BASE}/api/sendFile`);
  if (!envio) return undefined;
  const corpo = JSON.parse(String((envio[1] as RequestInit).body)) as { file?: { filename?: string } };
  return corpo.file?.filename;
}

// ─── repetir envio que falhou ───────────────────────────────────────────────

async function repetirEnvio(metadata: Record<string, unknown>) {
  const { supabase } = criarDubleDoHandler({
    conversation: conversaRow(),
    mensagensIniciais: [
      documentoEnviado({ status: "failed", error_code: "channel_disabled", error_message: "Canal desativado", metadata }),
    ],
  });
  estado.banco = supabase;
  const res = await POST(
    new NextRequest(`http://localhost/api/v1/messages/${MENSAGEM}/retry`, { method: "POST", body: "{}" }),
    { params: Promise.resolve({ id: MENSAGEM }) },
  );
  return { status: res.status, nome: nomeNoWhatsApp() };
}

describe("repetir envio que falhou: o documento sai com o nome original (#4457)", () => {
  it("o cliente recebe o documento com o nome que a pessoa deu, não o do objeto", async () => {
    const { status, nome } = await repetirEnvio({ media_filename: VOUCHER });

    expect(status).toBe(200);
    expect(nome).toBe(VOUCHER);
  });

  it("linha sem nome: sai o nome do objeto, como antes", async () => {
    const { status, nome } = await repetirEnvio({});

    expect(status).toBe(200);
    expect(nome).toBe("out-3f9a2b.pdf");
  });
});

// ─── reenvio desacelerado ───────────────────────────────────────────────────

const CRIADO = Date.parse("2026-11-17T10:00:00Z");

function evento(): EventRow {
  return {
    id: "ev-1",
    organization_id: ORG,
    event_type: EVENTO_REENVIO_DESACELERADO,
    entity_kind: "message",
    entity_id: MENSAGEM,
    payload: { message_id: MENSAGEM, queued_reason: "zernio_throttled", espera_ms: null },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(CRIADO).toISOString(),
  } as unknown as EventRow;
}

/**
 * O banco do CONSUMIDOR: a leitura da linha, a fila da conversa (vazia) e a
 * trava. O dublê compartilhado não tem os filtros `lt`/`gt` da fila, e o envio
 * em si roda no dublê compartilhado, pelo `enviar` injetado.
 */
function bancoDoConsumidor(linha: Record<string, unknown>): SupabaseClient {
  const from = () => {
    let patch: Record<string, unknown> | null = null;
    let daFila = false;
    const exec = () => {
      if (patch) {
        Object.assign(linha, patch, { updated_at: "v2" });
        return { data: { id: linha.id, updated_at: linha.updated_at }, error: null };
      }
      return { data: daFila ? [] : structuredClone(linha), error: null };
    };
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      update: (p: Record<string, unknown>) => ((patch = p), cadeia),
      eq: (coluna: string) => ((daFila ||= coluna === "conversation_id"), cadeia),
      neq: () => cadeia,
      lt: () => cadeia,
      gt: () => cadeia,
      limit: () => cadeia,
      maybeSingle: async () => exec(),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(ok(exec())),
    };
    return cadeia;
  };
  return { from } as unknown as SupabaseClient;
}

async function reenvioDesacelerado(metadata: Record<string, unknown>) {
  const { supabase } = criarDubleDoHandler({ conversation: conversaRow() });
  const linha = documentoEnviado({
    status: "queued",
    metadata: { queued_reason: "zernio_throttled", ...metadata },
  });
  const r = await tratarReenvioDesacelerado(evento(), {
    admin: bancoDoConsumidor(linha),
    agora: () => CRIADO + ESPERA_PADRAO_MS,
    enviar: (_admin: SupabaseClient, ctx: HandlerCtx, corpo) => sendMessageHandler(supabase, ctx, corpo),
  });
  return { resultado: r, nome: nomeNoWhatsApp() };
}

describe("reenvio desacelerado: o documento sai com o nome original (#4457)", () => {
  it("o cliente recebe o documento com o nome que a pessoa deu, não o do objeto", async () => {
    const { resultado, nome } = await reenvioDesacelerado({ media_filename: VOUCHER });

    expect(resultado).toMatchObject({ status: "ok", detail: "reenvio_sent" });
    expect(nome).toBe(VOUCHER);
  });

  it("linha sem nome: sai o nome do objeto, como antes", async () => {
    const { resultado, nome } = await reenvioDesacelerado({});

    expect(resultado).toMatchObject({ status: "ok", detail: "reenvio_sent" });
    expect(nome).toBe("out-3f9a2b.pdf");
  });
});
