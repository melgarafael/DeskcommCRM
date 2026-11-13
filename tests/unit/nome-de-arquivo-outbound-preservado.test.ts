/**
 * PRESERVAÇÃO DO NOME ORIGINAL DE ARQUIVOS NO ENVIO (OUTBOUND) (#4422, #2613).
 *
 * Ao enviar uma mídia (documento, vídeo, imagem) com `media_filename`:
 * 1. O motor do WhatsApp (WAHA) recebe o `filename` original limpo no payload de despacho.
 * 2. A linha em `messages` persiste `metadata.media_filename` com o nome original limpo.
 * 3. Sem `media_filename` informado, o comportamento canônico (fallback para o basename
 *    do storage path) continua preservado sem inventar dados na metadata.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import type { SendMessageInput } from "@/lib/schemas";
import { CHAVE_DO_NOME_NA_METADATA } from "@/lib/messaging/media/nome-de-arquivo";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const USUARIO = "77777777-7777-4777-8777-777777777777";
const STORAGE_PATH = `${ORG}/${CONV}/out-abcd-1234.pdf`;

const { signedUrl } = vi.hoisted(() => ({
  signedUrl: vi.fn(async () => ({
    data: { signedUrl: "https://storage.example/sign/out-abcd-1234.pdf" },
    error: null,
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: signedUrl }) },
  }),
}));

const disparos: Array<{ kind: string; media?: { filename?: string; url?: string } }> = [];

vi.mock("@/lib/channels", async () => {
  const actual = await vi.importActual<typeof import("@/lib/channels")>("@/lib/channels");
  return {
    ...actual,
    getAdapter: () => ({
      codes: { sendFailed: "send_failed" },
      send: vi.fn(async (opts: { kind: string; media?: { filename?: string; url?: string } }) => {
        disparos.push(opts);
        return { externalId: "wamid.outbound-123" };
      }),
    }),
  };
});

describe("Preservação do Nome Original de Arquivos no Envio (Outbound)", () => {
  afterEach(() => {
    disparos.length = 0;
    vi.clearAllMocks();
  });

  function contexto(): HandlerCtx {
    return {
      organization_id: ORG,
      requestId: "req-1",
      actor: { type: "user", id: USUARIO, role: "agent" },
    };
  }

  function bancoBase() {
    return criarDubleDoHandler({
      organizacao: { id: ORG },
      canais: [{ id: SESSAO, status: "connected", provider: "waha", session_name: "sessao-1" }],
      contatos: [{ id: CONTATO, wa_id: "5542999693272@c.us" }],
      conversas: [{ id: CONV, channel_session_id: SESSAO, contact_id: CONTATO }],
    });
  }

  it("repassa media_filename original para o adaptador WAHA e grava em metadata.media_filename", async () => {
    const { supabase, mensagens } = bancoBase();
    const nomeOriginal = "Balancete Outubro 2026.pdf";

    const input: SendMessageInput = {
      conversation_id: CONV,
      type: "document",
      media_storage_path: STORAGE_PATH,
      media_mime: "application/pdf",
      media_filename: nomeOriginal,
    };

    const res = await sendMessageHandler(supabase, contexto(), input);

    expect(res).toBeDefined();
    // 1. Prova do adaptador: WAHA recebe o nome amigável para entregar no WhatsApp
    expect(disparos).toHaveLength(1);
    expect(disparos[0]?.media?.filename).toBe(nomeOriginal);

    // 2. Prova do banco: metadata persiste media_filename
    const gravada = mensagens.find((m) => m.id === res.id);
    expect(gravada).toBeDefined();
    const meta = (gravada?.metadata ?? {}) as Record<string, unknown>;
    expect(meta[CHAVE_DO_NOME_NA_METADATA]).toBe(nomeOriginal);
  });

  it("sanitiza caracteres de controle no nome antes de despachar e gravar", async () => {
    const { supabase, mensagens } = bancoBase();
    const nomeComControle = "Balancete\u0000\u200E_Outubro.pdf";
    const nomeLimpoEsperado = "Balancete_Outubro.pdf";

    const input: SendMessageInput = {
      conversation_id: CONV,
      type: "document",
      media_storage_path: STORAGE_PATH,
      media_mime: "application/pdf",
      media_filename: nomeComControle,
    };

    const res = await sendMessageHandler(supabase, contexto(), input);

    expect(disparos[0]?.media?.filename).toBe(nomeLimpoEsperado);
    const gravada = mensagens.find((m) => m.id === res.id);
    const meta = (gravada?.metadata ?? {}) as Record<string, unknown>;
    expect(meta[CHAVE_DO_NOME_NA_METADATA]).toBe(nomeLimpoEsperado);
  });

  it("sem media_filename, mantém o fallback canônico do storage_path sem inventar na metadata", async () => {
    const { supabase, mensagens } = bancoBase();

    const input: SendMessageInput = {
      conversation_id: CONV,
      type: "document",
      media_storage_path: STORAGE_PATH,
      media_mime: "application/pdf",
    };

    const res = await sendMessageHandler(supabase, contexto(), input);

    expect(disparos[0]?.media?.filename).toBe("out-abcd-1234.pdf");
    const gravada = mensagens.find((m) => m.id === res.id);
    const meta = (gravada?.metadata ?? {}) as Record<string, unknown>;
    expect(meta[CHAVE_DO_NOME_NA_METADATA]).toBeUndefined();
  });
});
