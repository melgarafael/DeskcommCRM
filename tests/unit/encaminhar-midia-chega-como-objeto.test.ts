/**
 * A MÍDIA ENCAMINHADA CHEGA COMO OBJETO — E A GUARDA ANTI-SSRF É QUEM PROVA.
 *
 * ─── Por que este arquivo NÃO dubla o handler ───────────────────────────────
 *
 * O teste anterior do encaminhamento dubla `sendMessageHandler`, e foi por isso
 * que ele não viu o defeito: a guarda anti-SSRF do envio mora DENTRO do handler
 * (`app/api/v1/messages/_handler.ts`), então um handler dublado nunca a executa.
 * O encaminhamento de uma imagem recebida passava verde no teste e devolvia 422
 * `unsafe_media_url` para a pessoa — com o texto técnico "media_url recusada".
 *
 * Aqui o handler é o REAL, com o dublê de banco compartilhado, e o que se mede é
 * o que o provedor recebe: a mídia do encaminhamento sai por
 * `media_storage_path` (o objeto COPIADO para a pasta da conversa de destino,
 * assinado pelo Storage), nunca pela `media_url` crua que o WAHA mandou.
 *
 * A sabotagem que este teste pega, e que foi rodada à mão: devolver o envio pela
 * `media_url` crua (sem `media_storage_path`) faz a guarda real recusar
 * `http://localhost:3000/api/files/default/ABC.jpg` com `unsafe_url:https_required`
 * — 422 `unsafe_media_url`, e o teste fica VERMELHO pelo motivo certo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORIGEM_ID = "22222222-2222-4222-8222-222222222222";
const ORIGEM_CONV = "33333333-3333-4333-8333-333333333333";
const DESTINO_CONV = "44444444-4444-4444-8444-444444444444";
const SESSAO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const USUARIO = "77777777-7777-4777-8777-777777777777";
const WAHA_BASE = "http://localhost:3030";

/** A URL que o inbound do WAHA grava (medida do defeito, literal). */
const URL_DO_WAHA = "http://localhost:3000/api/files/default/ABC.jpg";
/** O objeto que o worker `media-persist` guardou para essa mesma mensagem. */
const OBJETO_NA_ORIGEM = `${ORG}/${ORIGEM_CONV}/m1.jpg`;
const OBJETO_NO_DESTINO = `${ORG}/${DESTINO_CONV}/m1.jpg`;

// A cópia e a assinatura saem pelo admin client, que valida env no import.
const { copias, copy, signedUrl } = vi.hoisted(() => {
  const copias: Array<{ origem: string; destino: string }> = [];
  return {
    copias,
    copy: vi.fn(async (origem: string, destino: string) => {
      copias.push({ origem, destino });
      return { error: null };
    }),
    signedUrl: vi.fn(async () => ({
      data: { signedUrl: "https://storage.example/sign/m1.jpg" },
      error: null,
    })),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ copy, createSignedUrl: signedUrl }) },
  }),
}));

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-1",
  idioma: "pt-BR",
};

/** A linha de `conversations` que o envio lê — a MESMA do teste do handler. */
function conversaRow() {
  return {
    id: DESTINO_CONV,
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

/** A mensagem RECEBIDA: a URL do WAHA e o objeto que a persistência guardou. */
function origemRecebida(extra: Record<string, unknown> = {}) {
  return {
    id: ORIGEM_ID,
    organization_id: ORG,
    conversation_id: ORIGEM_CONV,
    type: "image",
    body: "Olha o comprovante",
    media_url: URL_DO_WAHA,
    media_storage_path: OBJETO_NA_ORIGEM,
    media_mime: "image/jpeg",
    revoked_at: null,
    ...extra,
  };
}

function dubleCom(origem: Record<string, unknown>) {
  return criarDubleDoHandler({ conversation: conversaRow(), mensagensIniciais: [origem] });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  copias.length = 0;
  vi.clearAllMocks();
});

describe("encaminhar mídia recebida — objeto copiado, nunca a media_url crua", () => {
  it("copia o objeto para a pasta do DESTINO e o envia por media_storage_path", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      Response.json({ id: { _serialized: "MEDIA1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { supabase, capturas } = dubleCom(origemRecebida());

    const mensagem = await encaminharMensagem(supabase, ctx, {
      messageId: ORIGEM_ID,
      conversationIdDestino: DESTINO_CONV,
      via: "session",
    });

    // 1. O objeto foi COPIADO da pasta da origem para a do destino.
    expect(copias).toEqual([{ origem: OBJETO_NA_ORIGEM, destino: OBJETO_NO_DESTINO }]);
    // 2. O que o Storage assinou (e o provedor baixou) é o objeto do DESTINO.
    expect(signedUrl).toHaveBeenCalledWith(OBJETO_NO_DESTINO, 600);
    // 3. A linha criada carrega o PATH, e não a URL crua do WAHA.
    const linhaGravada = (capturas.inserts.messages ?? [])[0] as Record<string, unknown>;
    expect(linhaGravada.media_storage_path).toBe(OBJETO_NO_DESTINO);
    expect(linhaGravada.media_url).toBeNull();
    // 4. E a mídia saiu de verdade: o canal de imagem do WAHA foi chamado.
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `${WAHA_BASE}/api/sendImage`)).toBe(
      true,
    );
    expect(mensagem.status).toBe("sent");
    expect(mensagem.conversation_id).toBe(DESTINO_CONV);
  });

  it("mídia ainda não persistida (só a URL do WAHA): recusa com motivo TRADUZIDO, nunca com o texto técnico", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { supabase, capturas } = dubleCom(
      origemRecebida({ media_storage_path: null, body: "Olha o comprovante" }),
    );

    await expect(
      encaminharMensagem(supabase, ctx, {
        messageId: ORIGEM_ID,
        conversationIdDestino: DESTINO_CONV,
        via: "session",
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "nao_encaminhavel",
      message:
        "A mídia desta mensagem ainda não chegou ao CRM. Tente encaminhar de novo em alguns segundos.",
    });

    // Nada saiu pela rede e nenhuma linha nasceu — e o texto técnico da guarda
    // NÃO chegou à tela: a recusa é do encaminhamento, com motivo próprio.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(capturas.inserts.messages ?? []).toEqual([]);
    expect(copias).toEqual([]);
  });

  it("media-url da Meta (meta-media:<id>): mesma recusa traduzida", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    vi.stubGlobal("fetch", vi.fn());
    const { supabase } = dubleCom(
      origemRecebida({ media_storage_path: null, media_url: "meta-media:123456", type: "document" }),
    );

    await expect(
      encaminharMensagem(supabase, ctx, {
        messageId: ORIGEM_ID,
        conversationIdDestino: DESTINO_CONV,
        via: "session",
      }),
    ).rejects.toMatchObject({ status: 422, code: "nao_encaminhavel" });
  });

  it("objeto nosso fora da conversa de origem não é copiado — recusa alta", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    vi.stubGlobal("fetch", vi.fn());
    const { supabase } = dubleCom(
      // Caminho da conversa de OUTRA pessoa: copiar isso vazaria o arquivo dela.
      origemRecebida({ media_storage_path: `${ORG}/${DESTINO_CONV}/../${ORIGEM_CONV}/x.jpg` }),
    );

    await expect(
      encaminharMensagem(supabase, ctx, {
        messageId: ORIGEM_ID,
        conversationIdDestino: DESTINO_CONV,
        via: "session",
      }),
    ).rejects.toMatchObject({ status: 422, code: "nao_encaminhavel" });
    expect(copias).toEqual([]);
  });

  it("proposta em PDF (objeto fora da pasta da conversa): recusa sem 'tente de novo'", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    vi.stubGlobal("fetch", vi.fn());
    const { supabase } = dubleCom(
      // O path que `proposals/[id]/send` grava: `{org}/{proposta}.pdf`, no bucket
      // `propostas`. Tentar de novo nunca vai copiá-lo.
      origemRecebida({
        media_storage_path: `${ORG}/88888888-8888-4888-8888-888888888888.pdf`,
        type: "document",
      }),
    );

    await expect(
      encaminharMensagem(supabase, ctx, {
        messageId: ORIGEM_ID,
        conversationIdDestino: DESTINO_CONV,
        via: "session",
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "nao_encaminhavel",
      message: "Esta mídia não pode ser encaminhada.",
    });
    expect(copias).toEqual([]);
  });
});
