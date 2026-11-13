/**
 * DOCUMENTO PELA API CHEGA COM NOME — `POST /api/v1/messages` com `media_url`
 * (#4524).
 *
 * Este arquivo mede o envio pelo HANDLER, não pela função pura: o defeito da
 * issue não estava na limpeza de nome, estava no ELENCO do `media` do
 * `adapter.send` — `url`, `mime` e `caption`, sem `filename`. Sem `filename`,
 * quem escolhe o nome é o canal, e o WAHA grava o literal `file`. Uma suíte só
 * da função pura ficaria verde com o handler de volta ao defeito.
 *
 * Por isso o que se lê aqui é o CORPO que sai para o WAHA (`/api/sendFile`):
 * `file.filename` é o nome que o destinatário vê no celular.
 *
 * O caminho do INBOX não é tocado por este PR: o envio manual por lá é a #4457,
 * que está com outra pessoa. Os casos abaixo usam só a porta da API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }),
    },
    from: () => {
      const alvo: Record<string, unknown> = {
        maybeSingle: async () => ({ data: null, error: null }),
      };
      alvo.select = () => alvo;
      alvo.eq = () => alvo;
      alvo.is = () => alvo;
      return alvo;
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const PLANO = {
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: SESSION,
  is_group: false,
  group_chat_id: null,
  provider_conversation_id: null,
  contacts: {
    phone_number: "+595****3685",
    wa_identity: null,
    wa_lid: "999888",
    is_blocked: false,
  },
  channel_sessions: {
    provider: "waha",
    waha_session_name: "default",
    meta_phone_number_id: null,
    zernio_account_id: null,
    status: "WORKING",
    archived_at: null,
  },
};

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-4524",
};

/**
 * URL de mídia que passa pela guarda anti-SSRF sem tocar DNS: a exceção é a URL
 * ASSINADA do próprio Storage desta instalação — que é, de fato, o formato que
 * a proposta comercial usa. O último segmento é o candidato a nome.
 */
function urlAssinada(nome: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://test-placeholder.invalid";
  return `${base}/storage/v1/object/sign/whatsapp-media/${nome}`;
}

/** Documento como a issue manda, para o ramo `media_url` do handler. */
function documento(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    conversation_id: CONV,
    type: "document",
    media_url: urlAssinada("9f2c1a7b3d.pdf"),
    media_mime: "application/pdf",
    ...over,
  } as SendMessageInput;
}

/**
 * Mock do WAHA com a assinatura EXPLÍCITA: `vi.fn(async () => …)` infere
 * `calls: []`, e aí `c[0]` não compila (`TS2493`) — o tipo do dublê mentiria
 * sobre a chamada de rede que ele mesmo registra.
 */
function respostaWaha(id: string) {
  return vi.fn(async (..._args: unknown[]) => Response.json({ id }));
}

/** O corpo que foi para o WAHA no `sendFile`. */
function corpoDoEnvio(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const chamada = fetchMock.mock.calls.find((c) => String(c[0] ?? "").includes("/api/sendFile"));
  expect(chamada, "o documento saiu por /api/sendFile").toBeTruthy();
  return JSON.parse(String((chamada?.[1] as RequestInit | undefined)?.body ?? "{}")) as Record<
    string,
    unknown
  >;
}

function arquivoDoEnvio(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const corpo = corpoDoEnvio(fetchMock);
  return (corpo.file ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("documento por media_url chega com o nome escolhido (#4524)", () => {
  it("RED da issue: corpo com `metadata.media_filename` sai com ESSE nome, nunca `file`", async () => {
    const fetchMock = respostaWaha("MEDIA1");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = criarDubleDoHandler({ conversation: PLANO });
    const msg = await sendMessageHandler(
      supabase,
      ctx,
      documento({ metadata: { media_filename: "Diagnostico-Clinica-Exemplo.pdf" } }),
    );

    expect(msg.status).toBe("sent");
    const arquivo = arquivoDoEnvio(fetchMock);
    expect(arquivo.filename).toBe("Diagnostico-Clinica-Exemplo.pdf");
    expect(String(arquivo.filename).toLowerCase()).not.toBe("file");
  });

  it("campo novo `media_filename` vence a metadata e a URL", async () => {
    const fetchMock = respostaWaha("MEDIA2");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = createSupabase();
    await sendMessageHandler(
      supabase,
      ctx,
      documento({
        media_filename: "Contrato assinado.pdf",
        metadata: { media_filename: "Da metadata.pdf" },
      }),
    );

    expect(arquivoDoEnvio(fetchMock).filename).toBe("Contrato assinado.pdf");
  });

  it("sem nome nenhum, o último segmento da URL vira o nome", async () => {
    const fetchMock = respostaWaha("MEDIA3");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = createSupabase();
    await sendMessageHandler(supabase, ctx, documento());

    expect(arquivoDoEnvio(fetchMock).filename).toBe("9f2c1a7b3d.pdf");
  });

  it("URL sem extensão não vira nome sem sentido: reserva legível pelo MIME", async () => {
    const fetchMock = respostaWaha("MEDIA4");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = createSupabase();
    await sendMessageHandler(supabase, ctx, documento({ media_url: urlAssinada("9f2c1a7b3d") }));

    expect(arquivoDoEnvio(fetchMock).filename).toBe("documento.pdf");
  });

  it("acento e espaço chegam intactos ao payload", async () => {
    const fetchMock = respostaWaha("MEDIA5");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = createSupabase();
    await sendMessageHandler(
      supabase,
      ctx,
      documento({ media_filename: "Orçamento Ação 2026.pdf" }),
    );

    expect(arquivoDoEnvio(fetchMock).filename).toBe("Orçamento Ação 2026.pdf");
  });

  it("SEGURANÇA: nome com `../` não atravessa — nem no payload, nem na linha", async () => {
    const fetchMock = respostaWaha("MEDIA6");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase, capturas } = createSupabase();
    await sendMessageHandler(supabase, ctx, documento({ media_filename: "../../etc/passwd.pdf" }));

    const nome = String(arquivoDoEnvio(fetchMock).filename);
    expect(nome).toBe("passwd.pdf");
    expect(nome).not.toContain("..");
    expect(nome).not.toContain("/");

    const linha = capturas.inserts.messages?.at(-1) ?? {};
    expect(JSON.stringify(linha.metadata)).not.toContain("..");
  });

  it("CONTROLE POSITIVO: requisição ANTIGA (sem o campo novo) é aceita e sai", async () => {
    // O corpo que existe hoje em produção: `conversation_id`, `type`,
    // `media_url`, `media_mime` — e nada mais. Tem de continuar entrando e
    // saindo; o que muda é só o rótulo, que deixa de ser `file`.
    const fetchMock = respostaWaha("MEDIA7");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase, capturas } = createSupabase();
    const msg = await sendMessageHandler(supabase, ctx, documento());

    expect(msg.status).toBe("sent");
    expect(fetchMock.mock.calls.some((c) => String(c[0] ?? "").includes("/api/sendFile"))).toBe(
      true,
    );
    // A linha antiga NÃO ganha `media_filename` no JSONB: sem o campo novo,
    // nada de novo é gravado.
    const linha = capturas.inserts.messages?.at(-1) ?? {};
    expect(linha.metadata as Record<string, unknown> | undefined).not.toHaveProperty(
      "media_filename",
    );
    // E o objeto no Storage não é renomeado: a URL que viajou é a mesma.
    expect(arquivoDoEnvio(fetchMock).url).toBe(urlAssinada("9f2c1a7b3d.pdf"));
  });

  it("nome vazio, só barras ou gigante: envio sai, com reserva legível", async () => {
    // Pela rota HTTP, `""` e o nome de 600 caracteres param antes, no schema
    // (`media_filename` é 1–255, desde a #4457). Aqui o handler é chamado
    // direto: a guarda dele vale para quem chega sem passar pela rota.
    for (const nomeExplicito of ["", "   ", "///", `${"a".repeat(600)}.pdf`]) {
      const fetchMock = respostaWaha("MEDIA8");
      vi.stubGlobal("fetch", fetchMock);

      const { supabase } = createSupabase();
      const msg = await sendMessageHandler(
        supabase,
        ctx,
        documento({ media_filename: nomeExplicito }),
      );

      expect(msg.status, `entrada: ${JSON.stringify(nomeExplicito.slice(0, 12))}`).toBe("sent");
      const nome = String(arquivoDoEnvio(fetchMock).filename);
      expect(nome.length).toBeGreaterThan(0);
      expect(nome).not.toContain("/");
      expect(nome.toLowerCase()).not.toBe("file");
      if (nomeExplicito.endsWith(".pdf")) expect(nome.endsWith(".pdf")).toBe(true);
    }
  });

  it("a linha guarda o nome DECLARADO — o cartão e o download contam a mesma história", async () => {
    const fetchMock = respostaWaha("MEDIA9");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase, capturas } = createSupabase();
    await sendMessageHandler(supabase, ctx, documento({ media_filename: "Laudo final.pdf" }));

    const linha = capturas.inserts.messages?.at(-1) ?? {};
    expect((linha.metadata as Record<string, unknown>).media_filename).toBe("Laudo final.pdf");
  });

  it("o nome não muda a URL nem o MIME do objeto enviado", async () => {
    const fetchMock = respostaWaha("MEDIA10");
    vi.stubGlobal("fetch", fetchMock);

    const { supabase } = createSupabase();
    await sendMessageHandler(
      supabase,
      ctx,
      documento({ media_filename: "Outro nome.pdf", media_mime: "application/pdf" }),
    );

    const arquivo = arquivoDoEnvio(fetchMock);
    expect(arquivo.url).toBe(urlAssinada("9f2c1a7b3d.pdf"));
    expect(arquivo.mimetype).toBe("application/pdf");
    expect(arquivo.filename).toBe("Outro nome.pdf");
  });
});

/** Dublê novo por caso: capturas de um teste não vazam para o outro. */
function createSupabase() {
  return criarDubleDoHandler({ conversation: PLANO });
}
