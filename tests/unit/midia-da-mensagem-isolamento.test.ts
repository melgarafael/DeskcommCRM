/** A rota real só pode ler mídia no namespace da organização autorizada. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const MENSAGEM = "44444444-4444-4444-8444-444444444444";

const estado = vi.hoisted(() => ({
  mensagem: {} as Record<string, unknown>,
  filtros: [] as Array<[string, unknown]>,
  assinar: vi.fn(async (_path: string, _ttl: number, _opcoes?: { download: string }) => ({
    data: { signedUrl: "https://storage.example/signed/midia" }, error: null,
  })),
  baixar: vi.fn(async (_path: string) => ({ data: new Blob(["ogg"]), error: null })),
  buscarNoCanal: vi.fn(),
  converter: vi.fn(async () => Buffer.from("aac")),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "usuario" } }, error: null }) },
    from: () => {
      const query = {
        select: () => query,
        eq: (coluna: string, valor: unknown) => {
          estado.filtros.push([coluna, valor]);
          return query;
        },
        maybeSingle: async () => ({ data: estado.mensagem, error: null }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ idioma: "pt-BR" }) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: async () => ({ ok: true, org: { orgId: "11111111-1111-4111-8111-111111111111" } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: estado.assinar, download: estado.baixar }) },
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { id: "sessao", provider: "waha" }, error: null }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "id",
  DEFAULT_CHANNEL_PROVIDER: "waha",
  getAdapter: () => ({ fetchInboundMedia: estado.buscarNoCanal }),
  resolveSessionRef: () => ({ id: "sessao" }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/messaging/media/voice-transcode", () => ({
  ConversorOcupado: class extends Error {},
  TETO_REPRODUCAO_BYTES: 1024,
  paraReproducaoAac: estado.converter,
}));

import { GET } from "@/app/api/v1/messages/[id]/media/route";
import { VALIDADE_DO_LINK_DE_MIDIA_S } from "@/lib/messaging/media/link-temporario";

function pedir(formato = "") {
  return GET(new Request(`https://app.example/api/v1/messages/${MENSAGEM}/media${formato}`) as never, {
    params: Promise.resolve({ id: MENSAGEM }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.filtros = [];
  estado.mensagem = {
    id: MENSAGEM,
    organization_id: ORG,
    media_storage_path: `${ORG}/${CONVERSA}/entrada.ogg`,
    media_url: "media-do-canal",
    media_mime: "audio/ogg",
    media_size_bytes: 3,
    metadata: {},
    channel_session_id: "sessao",
  };
});

describe("mídia da mensagem respeita o namespace autorizado", () => {
  it("assina o objeto da organização ativa sem alterar o caminho", async () => {
    const resposta = await pedir();
    expect(resposta.status).toBe(302);
    expect(estado.assinar).toHaveBeenCalledExactlyOnceWith(
      `${ORG}/${CONVERSA}/entrada.ogg`, VALIDADE_DO_LINK_DE_MIDIA_S, undefined,
    );
    expect(estado.filtros).toContainEqual(["organization_id", ORG]);
    expect(estado.baixar).not.toHaveBeenCalled();
    expect(estado.buscarNoCanal).not.toHaveBeenCalled();
  });

  it.each(["", "?baixar=1"])("mensagem legível com objeto de outra organização não alcança o assinador (%s)", async (formato) => {
    estado.mensagem.media_storage_path = `${OUTRA_ORG}/${CONVERSA}/entrada.ogg`;
    const resposta = await pedir(formato);
    expect(estado.assinar).not.toHaveBeenCalled();
    expect(estado.baixar).not.toHaveBeenCalled();
    expect(estado.buscarNoCanal).not.toHaveBeenCalled();
    expect(resposta.status).toBe(404);
    expect(await resposta.json()).toMatchObject({ error: { code: "not_found", message: "Mensagem sem mídia." } });
  });

  it("o mesmo bloqueio ocorre antes do download para reprodução AAC", async () => {
    estado.mensagem.media_storage_path = `${OUTRA_ORG}/${CONVERSA}/entrada.ogg`;
    const resposta = await pedir("?formato=aac");
    expect(estado.baixar).not.toHaveBeenCalled();
    expect(estado.converter).not.toHaveBeenCalled();
    expect(estado.buscarNoCanal).not.toHaveBeenCalled();
    expect(resposta.status).toBe(404);
  });

  it.each([
    `${ORG}/${MENSAGEM}.pdf`,
    `${ORG}/${CONVERSA}/out-${MENSAGEM}.png`,
    `${ORG}/${CONVERSA}/catalogo-${MENSAGEM}.jpg`,
    `${ORG}/${CONVERSA}/${MENSAGEM}.bin`,
    `${ORG}/${CONVERSA}/2026/foto..final.jpg`,
    `${ORG}/${CONVERSA}/ação da clínica.pdf`,
    `${ORG}/${CONVERSA}/relatório\u00a0final.pdf`,
  ])("preserva o caminho legítimo %s", async (caminho) => {
    estado.mensagem.media_storage_path = caminho;
    const resposta = await pedir();
    expect(resposta.status).toBe(302);
    expect(estado.assinar).toHaveBeenCalledExactlyOnceWith(caminho, VALIDADE_DO_LINK_DE_MIDIA_S, undefined);
  });

  it("download autorizado preserva o nome nas opções, sem trocá-lo pelo caminho", async () => {
    estado.mensagem.metadata = { media_filename: "Orçamento ação.xlsx" };
    const resposta = await pedir("?baixar=1");
    expect(resposta.status).toBe(302);
    expect(estado.assinar).toHaveBeenCalledExactlyOnceWith(
      `${ORG}/${CONVERSA}/entrada.ogg`, VALIDADE_DO_LINK_DE_MIDIA_S,
      { download: "Orçamento ação.xlsx" },
    );
    expect(estado.baixar).not.toHaveBeenCalled();
    expect(estado.buscarNoCanal).not.toHaveBeenCalled();
  });

  it.each([
    "",
    ORG,
    `${ORG}x/${CONVERSA}/entrada.ogg`,
    `/${ORG}/${CONVERSA}/entrada.ogg`,
    `https://storage.example/${ORG}/entrada.ogg`,
    `${ORG}/`,
    `${ORG}//entrada.ogg`,
    `${ORG}/./entrada.ogg`,
    `${ORG}/${CONVERSA}/../entrada.ogg`,
    `${ORG}/${CONVERSA}/../../${OUTRA_ORG}/entrada.ogg`,
    `${ORG}/${CONVERSA}\\entrada.ogg`,
    `${ORG}/${CONVERSA}/%2e%2e/entrada.ogg`,
    `${ORG}/${CONVERSA}/%252e%252e/entrada.ogg`,
    `${ORG}/${CONVERSA}%2fentrada.ogg`,
    `${ORG}/${CONVERSA}/entrada.ogg?download=1`,
    `${ORG}/${CONVERSA}/entrada.ogg#fragmento`,
    `${ORG}/${CONVERSA}/en\ttrada.ogg`,
    `${ORG}/${CONVERSA}/en\ntrada.ogg`,
    `${ORG}/${CONVERSA}/entrada.ogg `,
    `${ORG}/${CONVERSA}/entrada\u0000.ogg`,
  ])("recusa caminho não canônico antes de acessar o Storage: %j", async (caminho) => {
    estado.mensagem.media_storage_path = caminho;
    for (const formato of ["", "?baixar=1", "?formato=aac"]) {
      const resposta = await pedir(formato);
      expect(resposta.status).toBe(404);
      expect(resposta.headers.get("location")).toBeNull();
      expect(await resposta.json()).toMatchObject({ error: { code: "not_found", message: "Mensagem sem mídia." } });
    }
    expect(estado.assinar).not.toHaveBeenCalled();
    expect(estado.baixar).not.toHaveBeenCalled();
    expect(estado.converter).not.toHaveBeenCalled();
    expect(estado.buscarNoCanal).not.toHaveBeenCalled();
  });

  it("continua baixando o objeto autorizado para reprodução AAC", async () => {
    const resposta = await pedir("?formato=aac");
    expect(resposta.status).toBe(200);
    expect(estado.baixar).toHaveBeenCalledExactlyOnceWith(`${ORG}/${CONVERSA}/entrada.ogg`);
    expect(estado.converter).toHaveBeenCalledExactlyOnceWith(Buffer.from("ogg"), ORG);
    expect(estado.assinar).not.toHaveBeenCalled();
  });

  it("sem objeto persistido, continua buscando a mídia no canal autorizado", async () => {
    estado.mensagem.media_storage_path = null;
    estado.buscarNoCanal.mockResolvedValueOnce({ buffer: Buffer.from("canal"), mime: "image/png" });
    const resposta = await pedir();
    expect(resposta.status).toBe(200);
    expect(await resposta.text()).toBe("canal");
    expect(estado.buscarNoCanal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ organizationId: ORG }));
    expect(estado.assinar).not.toHaveBeenCalled();
    expect(estado.baixar).not.toHaveBeenCalled();
  });
});
