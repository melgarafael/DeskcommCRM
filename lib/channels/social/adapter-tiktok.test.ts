/**
 * O adapter das redes sociais numa conta do TikTok (A21): a recusa de FORMATO é
 * nossa, definitiva e acontece ANTES de qualquer chamada ao provedor.
 *
 * A regra em si (o que o TikTok aceita) é provada em `formato-do-envio.test.ts`;
 * aqui se prova a ligação: a rede é lida da sessão, a recusa sai como falha
 * PERMANENTE (o turno não repete) e o provedor nem é chamado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

let redeDaSessao: string | null = "tiktok";
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "is"]) cadeia[metodo] = () => cadeia;
      cadeia.maybeSingle = async () => ({
        data: redeDaSessao === null ? { metadata: {} } : { metadata: { social_platform: redeDaSessao } },
        error: null,
      });
      return cadeia;
    },
  }),
}));
const CREDS = { accountId: "6a3572a15f7d1751ab117832", apiKey: "sk_test", baseUrl: "https://zernio.com/api", source: "session" as const };
vi.mock("@/lib/channels/zernio/credentials", () => ({
  resolveZernioCreds: async () => CREDS,
  zernioCredsFromEnv: () => CREDS,
  zernioCredsForAccountId: async () => CREDS,
  zernioBaseUrl: () => "https://zernio.com/api",
}));

import { naturezaDaFalhaDeEnvio } from "../falha-de-envio";
import { socialAdapter } from "./adapter";

const ORG = "00000000-0000-4000-8000-000000004700";

function envelope(extra: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    sessionRef: CREDS.accountId,
    to: "provider-thread",
    providerConversationId: "6a3580f68fcd5b3a5b946bf8",
    kind: "text" as const,
    body: "Olá!",
    ...extra,
  } as Parameters<typeof socialAdapter.send>[0];
}

async function recusa(promessa: Promise<unknown>) {
  const erro = await promessa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro, "o envio devia ter sido recusado").not.toBeNull();
  return { erro: erro as Error, natureza: naturezaDaFalhaDeEnvio(erro).natureza };
}

beforeEach(() => {
  fetchMock.mockReset();
  redeDaSessao = "tiktok";
});

describe("adapter das redes sociais: conta do TikTok", () => {
  it("vídeo e áudio: recusa permanente com a saída no texto, e o provedor NEM é chamado", async () => {
    for (const kind of ["video", "audio"] as const) {
      const { erro, natureza } = await recusa(
        socialAdapter.send(envelope({ kind, body: undefined, media: { url: "https://signed.example/a", mime: "video/mp4" } })),
      );
      expect(natureza, kind).toBe("permanente");
      expect(erro.message, kind).toMatch(/só aceita texto ou uma imagem JPG ou PNG de até 3 MB/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imagem com legenda: recusa permanente (o TikTok não aceita imagem e texto juntos)", async () => {
    const { erro, natureza } = await recusa(
      socialAdapter.send(
        envelope({
          kind: "image",
          body: undefined,
          media: { url: "https://signed.example/a.jpg", mime: "image/jpeg", caption: "Casa de 3 quartos" },
        }),
      ),
    );
    expect(natureza).toBe("permanente");
    expect(erro.message).toMatch(/não aceita imagem e texto na mesma mensagem/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("texto e imagem JPG sem legenda seguem para o provedor", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "tt-1" } }), { status: 200 }),
    );
    const texto = await socialAdapter.send(envelope());
    expect(texto.externalId).toBe(`social:${CREDS.accountId}:tt-1`);

    const imagem = await socialAdapter.send(
      envelope({ kind: "image", body: undefined, media: { url: "https://signed.example/a.jpg", mime: "image/jpeg" } }),
    );
    expect(imagem.externalId).toBe(`social:${CREDS.accountId}:tt-1`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("outra rede social não ganha a régua do TikTok: o vídeo segue para o provedor", async () => {
    redeDaSessao = "instagram";
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "ig-1" } }), { status: 200 }),
    );
    await socialAdapter.send(
      envelope({ kind: "video", body: undefined, media: { url: "https://signed.example/a", mime: "video/mp4" } }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
