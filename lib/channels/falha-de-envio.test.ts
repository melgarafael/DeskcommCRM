/**
 * A natureza da falha de envio: o que o adapter sabe chega ao handler.
 *
 * Prende as duas pontas do contrato do lado do canal:
 *   - a regra pura (status HTTP → permanente/transitória, erro desconhecido =
 *     transitória, que é o comportamento de antes);
 *   - os dois adapters que classificam hoje: o das redes sociais (recusa HTTP
 *     pelo `upstreamStatus`, recusas próprias marcadas) e o do WhatsApp
 *     intermediado (`zernio_send_failed` com o status, texto inalterado).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const CREDS = { accountId: "6a3572a15f7d1751ab117832", apiKey: "sk_test", baseUrl: "https://zernio.com/api", source: "session" as const };
vi.mock("@/lib/channels/zernio/credentials", () => ({
  resolveZernioCreds: async () => CREDS,
  zernioCredsFromEnv: () => CREDS,
  zernioCredsForAccountId: async () => CREDS,
  zernioBaseUrl: () => "https://zernio.com/api",
}));

import {
  falhaPermanenteNaMensagem,
  FalhaDeEnvioDoCanal,
  naturezaDaFalhaDeEnvio,
  naturezaDoStatusHttp,
  registroDaFalhaDeEnvio,
} from "./falha-de-envio";
import { SocialError } from "./social/client";
import { socialAdapter } from "./social/adapter";
import { zernioAdapter } from "./adapters/zernio";

const ORG = "00000000-0000-4000-8000-000000004700";
const THREAD = "6a3580f68fcd5b3a5b946bf8";

beforeEach(() => fetchMock.mockReset());

describe("a regra pura", () => {
  it("4xx do provedor é recusa deste pedido: permanente", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 415, 422]) {
      expect(naturezaDoStatusHttp(status), String(status)).toBe("permanente");
    }
  });

  it("tempo esgotado, cedo demais, devagar e 5xx: transitória", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(naturezaDoStatusHttp(status), String(status)).toBe("transitoria");
    }
  });

  it("erro que ninguém classificou segue transitório — o comportamento de antes", () => {
    expect(naturezaDaFalhaDeEnvio(new Error("fetch failed")).natureza).toBe("transitoria");
    expect(naturezaDaFalhaDeEnvio(new TypeError("network")).natureza).toBe("transitoria");
    expect(naturezaDaFalhaDeEnvio("texto solto").natureza).toBe("transitoria");
    expect(naturezaDaFalhaDeEnvio(null).natureza).toBe("transitoria");
    // Sem status do provedor (o `SocialError` de resposta ilegível) não há o que ler.
    expect(naturezaDaFalhaDeEnvio(new SocialError("lista inválida")).natureza).toBe("transitoria");
  });

  it("o status do provedor no erro do cliente HTTP decide", () => {
    expect(naturezaDaFalhaDeEnvio(new SocialError("x", 502, 400))).toEqual({ natureza: "permanente", statusHttp: 400 });
    expect(naturezaDaFalhaDeEnvio(new SocialError("x", 502, 503))).toEqual({ natureza: "transitoria", statusHttp: 503 });
    expect(naturezaDaFalhaDeEnvio(new SocialError("x", 429, 429)).natureza).toBe("transitoria");
  });

  it("a classificação do adapter vale como ele disse", () => {
    expect(naturezaDaFalhaDeEnvio(new FalhaDeEnvioDoCanal("x", "permanente"))).toEqual({ natureza: "permanente" });
    expect(naturezaDaFalhaDeEnvio(new FalhaDeEnvioDoCanal("x", "transitoria", 400))).toEqual({
      natureza: "transitoria",
      statusHttp: 400,
    });
  });

  it("o registro gravado na mensagem e a leitura dele", () => {
    const permanente = registroDaFalhaDeEnvio(new SocialError("x", 502, 400));
    expect(permanente).toEqual({ natureza: "permanente", status_http: 400 });
    expect(falhaPermanenteNaMensagem({ falha_de_envio: permanente, outra: 1 })).toBe(true);
    expect(falhaPermanenteNaMensagem({ falha_de_envio: registroDaFalhaDeEnvio(new Error("rede")) })).toBe(false);
    // Linha gravada antes desta mudança, ou metadata ilegível: não é permanente.
    for (const legado of [null, undefined, {}, { falha_de_envio: null }, { falha_de_envio: "permanente" }, "x"]) {
      expect(falhaPermanenteNaMensagem(legado)).toBe(false);
    }
  });
});

function envelopeSocial(extra: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    sessionRef: CREDS.accountId,
    to: "provider-thread",
    providerConversationId: THREAD,
    kind: "audio" as const,
    media: { url: "https://signed.example/voz.mp3", mime: "audio/mpeg" },
    ...extra,
  } as Parameters<typeof socialAdapter.send>[0];
}

async function naturezaDoQueLancou(promessa: Promise<unknown>) {
  const erro = await promessa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro, "o envio devia ter falhado").not.toBeNull();
  return naturezaDaFalhaDeEnvio(erro);
}

describe("adapter das redes sociais", () => {
  it("⭐ o 400 do provedor (o caso medido ao vivo) sai permanente", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    expect(await naturezaDoQueLancou(socialAdapter.send(envelopeSocial()))).toEqual({
      natureza: "permanente",
      statusHttp: 400,
    });
  });

  it("5xx e queda de rede seguem transitórios", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect((await naturezaDoQueLancou(socialAdapter.send(envelopeSocial()))).natureza).toBe("transitoria");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await naturezaDoQueLancou(socialAdapter.send(envelopeSocial()))).natureza).toBe("transitoria");
  });

  it("as recusas próprias do adapter são permanentes", async () => {
    expect(
      (await naturezaDoQueLancou(socialAdapter.send(envelopeSocial({ providerConversationId: null })))).natureza,
    ).toBe("permanente");
    expect(
      (await naturezaDoQueLancou(socialAdapter.send(envelopeSocial({ kind: "location" })))).natureza,
    ).toBe("permanente");
  });

  it("resposta sem id: pode ter saído — permanente, para não mandar duas vezes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    expect((await naturezaDoQueLancou(socialAdapter.send(envelopeSocial()))).natureza).toBe("permanente");
  });
});

describe("adapter do WhatsApp intermediado", () => {
  const envelope = {
    organizationId: ORG,
    sessionRef: CREDS.accountId,
    to: "595991733685",
    providerConversationId: THREAD,
    kind: "text" as const,
    body: "olá",
  } as Parameters<typeof zernioAdapter.send>[0];
  const responde = (status: number, json: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: status < 400, status, statusText: "", headers: new Headers(), json: async () => json });

  it("400 sai permanente, com o MESMO texto de antes", async () => {
    responde(400, { success: false, code: "INVALID_MEDIA", error: "bad" });
    const erro = await zernioAdapter.send(envelope).catch((e: unknown) => e);
    expect(String((erro as Error).message)).toBe("zernio_send_failed: 400 INVALID_MEDIA: bad");
    expect(naturezaDaFalhaDeEnvio(erro)).toEqual({ natureza: "permanente", statusHttp: 400 });
  });

  it("500 segue transitório; o limite de velocidade num 400 também", async () => {
    responde(500, { success: false, error: "boom" });
    expect((await naturezaDoQueLancou(zernioAdapter.send(envelope))).natureza).toBe("transitoria");
    responde(400, { success: false, code: "platform_api_error", error: "slow", platformError: { code: 130429 } });
    expect((await naturezaDoQueLancou(zernioAdapter.send(envelope))).natureza).toBe("transitoria");
  });
});
