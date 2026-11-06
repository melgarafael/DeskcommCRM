/**
 * `GET /api/v1/messages/{id}/media?formato=aac` — F2 da ADR-0006.
 *
 * O Safari do iPhone (antes do 18.4) não toca ogg/opus, que é o formato de
 * toda nota de voz do WhatsApp. A rota converte NA HORA para AAC em MP4 e
 * devolve os bytes `no-store`; o aparelho toca em memória. Nada é guardado.
 *
 * O que estes casos prendem: validação depois da autorização, o teto por
 * pessoa (com os cabeçalhos que o cliente lê), só áudio convertível, o filtro
 * de organização na leitura, e que a falha do ffmpeg vira 502 com código
 * próprio — nunca um 200 com o ogg mudo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/ai/dispatcher/rate-limit";
import type * as VoiceTranscode from "@/lib/messaging/media/voice-transcode";

const estado = vi.hoisted(() => ({
  usuario: { id: "usuario-1" } as { id: string } | null,
  mensagem: null as Record<string, unknown> | null,
  eqs: [] as Array<[string, unknown]>,
  limite: { allowed: true, count: 1, limit: 30, window_sec: 60 } as RateLimitResult,
  baldes: [] as string[],
  baixado: Buffer.from("ogg-bytes"),
}));

const converter = vi.hoisted(() =>
  vi.fn<typeof VoiceTranscode.paraReproducaoAac>(async () => Buffer.from("mp4-aac")),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: estado.usuario },
        error: estado.usuario ? null : { message: "sem sessão" },
      }),
    },
    from: () => {
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          estado.eqs.push([coluna, valor]);
          return cadeia;
        },
        maybeSingle: async () => ({ data: estado.mensagem, error: null }),
      };
      return cadeia;
    },
  }),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ idioma: "pt-BR" }) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: async () => ({ ok: true, org: { orgId: "org-1" } }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string): Promise<RateLimitResult> => {
    estado.baldes.push(balde);
    return estado.limite;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([estado.baixado]), error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://storage/x" }, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "id",
  DEFAULT_CHANNEL_PROVIDER: "waha",
  getAdapter: () => ({}),
  resolveSessionRef: () => null,
}));
vi.mock("@/lib/messaging/media/voice-transcode", async (original) => ({
  ...(await original<typeof VoiceTranscode>()),
  paraReproducaoAac: converter,
}));

import { GET } from "@/app/api/v1/messages/[id]/media/route";

const audio = {
  id: "mensagem-1",
  media_url: null,
  media_mime: "audio/ogg; codecs=opus",
  media_size_bytes: 9,
  media_storage_path: "org-1/conv-1/in-a.ogg",
  metadata: {},
  channel_session_id: "s",
};

function pedir(formato?: string): Promise<Response> {
  const url = new URL("http://localhost/api/v1/messages/mensagem-1/media");
  if (formato !== undefined) url.searchParams.set("formato", formato);
  return GET(new Request(url) as never, { params: Promise.resolve({ id: "mensagem-1" }) });
}

async function codigo(r: Response): Promise<string | undefined> {
  return ((await r.json()) as { error?: { code?: string } }).error?.code;
}

beforeEach(() => {
  estado.usuario = { id: "usuario-1" };
  estado.mensagem = { ...audio };
  estado.eqs = [];
  estado.baldes = [];
  estado.limite = { allowed: true, count: 1, limit: 30, window_sec: 60 };
  estado.baixado = Buffer.from("ogg-bytes");
  converter.mockReset();
  converter.mockResolvedValue(Buffer.from("mp4-aac"));
});

describe("?formato=aac", () => {
  it("200 com audio/mp4, no-store e os bytes convertidos", async () => {
    const r = await pedir("aac");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mp4");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("mp4-aac");
    expect(converter.mock.calls[0]?.[0].toString()).toBe("ogg-bytes");
    // A vaga é contada pela organização da SESSÃO, nunca por algo do pedido.
    expect(converter.mock.calls[0]?.[1]).toBe("org-1");
  });

  it("a leitura da mensagem filtra a organização ativa", async () => {
    await pedir("aac");
    expect(estado.eqs).toContainEqual(["organization_id", "org-1"]);
    expect(estado.eqs).toContainEqual(["id", "mensagem-1"]);
  });

  it("422 para formato desconhecido — e sem converter nada", async () => {
    const r = await pedir("x");
    expect(r.status).toBe(422);
    expect(converter).not.toHaveBeenCalled();
  });

  it("sem sessão é 401, não 422: autorização antes da validação", async () => {
    estado.usuario = null;
    const r = await pedir("x");
    expect(r.status).toBe(401);
  });

  it("415 para o que não é áudio convertível", async () => {
    estado.mensagem = { ...audio, media_mime: "image/jpeg" };
    const r = await pedir("aac");
    expect(r.status).toBe(415);
    expect(converter).not.toHaveBeenCalled();
  });

  it("429 com Retry-After e X-RateLimit-* quando o teto da pessoa estoura", async () => {
    estado.limite = { allowed: false, count: 31, limit: 30, window_sec: 60 };
    const r = await pedir("aac");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.headers.get("x-ratelimit-limit")).toBe("30");
    expect(r.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(estado.baldes[0]).toBe("midia-aac:usuario-1");
    expect(converter).not.toHaveBeenCalled();
  });

  it("o teto da organização também conta, depois do da pessoa", async () => {
    await pedir("aac");
    expect(estado.baldes).toEqual(["midia-aac:usuario-1", "midia-aac-org:org-1"]);
  });

  it("413 quando o arquivo passa do teto — antes de baixar", async () => {
    estado.mensagem = { ...audio, media_size_bytes: 6 * 1024 * 1024 };
    const r = await pedir("aac");
    expect(r.status).toBe(413);
    expect(converter).not.toHaveBeenCalled();
  });

  it("502 conversao_indisponivel quando o ffmpeg falha", async () => {
    converter.mockRejectedValue(new Error("ffmpeg_exit_1"));
    const r = await pedir("aac");
    expect(r.status).toBe(502);
    expect(await codigo(r)).toBe("conversao_indisponivel");
  });

  it("503 com Retry-After quando o conversor do processo está cheio — espera, não defeito", async () => {
    const { ConversorOcupado } = await vi.importActual<typeof VoiceTranscode>("@/lib/messaging/media/voice-transcode");
    converter.mockRejectedValue(new ConversorOcupado());
    const r = await pedir("aac");
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(await codigo(r)).toBe("conversor_ocupado");
  });

  it("sem ?formato a rota segue como sempre: 302 para a URL assinada, sem converter", async () => {
    const r = await pedir();
    expect(r.status).toBe(302);
    expect(converter).not.toHaveBeenCalled();
    expect(estado.baldes).toEqual([]);
  });
});
