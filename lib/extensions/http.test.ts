import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  debt: vi.fn(),
  aal: vi.fn(),
  row: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.user,
  mfaEmDivida: mocks.debt,
  sessionAal: mocks.aal,
}));
vi.mock("@/lib/logger", () => ({ logger: { error: mocks.log } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle: mocks.row }) }) }) }),
  }),
}));

import {
  extensionFailure,
  operationKey,
  readExtensionBody,
  requireExtensionPlatform,
} from "./http";

function request(
  body: BodyInit | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/v1/extensions/catalogs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({
    id: "actor",
    idioma: "pt-BR",
    is_platform_admin: true,
    support: null,
  });
  mocks.row.mockResolvedValue({ data: { scope: "full", mfa_required: false }, error: null });
  mocks.debt.mockResolvedValue(false);
  mocks.aal.mockResolvedValue("aal1");
});
afterEach(() => vi.useRealTimers());

describe("autoridade de plataforma da extensão", () => {
  it("nega ator sem sessão antes de consultar a tabela", async () => {
    mocks.user.mockResolvedValue(null);
    const result = await requireExtensionPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mocks.row).not.toHaveBeenCalled();
  });
  it("revalida revogação e scope; flag em memória não concede escrita", async () => {
    for (const row of [null, { scope: "support_readonly", mfa_required: false }]) {
      mocks.row.mockResolvedValue({ data: row, error: null });
      const result = await requireExtensionPlatform();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  });
  it("nega acompanhamento, mesmo full, sem consulta privilegiada", async () => {
    mocks.user.mockResolvedValue({
      id: "actor",
      idioma: "pt-BR",
      is_platform_admin: true,
      support: { access_mode: "full" },
    });
    const result = await requireExtensionPlatform();
    expect(result.ok).toBe(false);
    expect(mocks.row).not.toHaveBeenCalled();
  });
  it("cobra política MFA mesmo antes de haver fator e cobra fator opcional cadastrado", async () => {
    mocks.row.mockResolvedValue({ data: { scope: "full", mfa_required: true }, error: null });
    expect((await requireExtensionPlatform()).ok).toBe(false);
    mocks.aal.mockResolvedValue("aal2");
    expect((await requireExtensionPlatform()).ok).toBe(true);
    mocks.row.mockResolvedValue({ data: { scope: "full", mfa_required: false }, error: null });
    mocks.debt.mockResolvedValue(true);
    expect((await requireExtensionPlatform()).ok).toBe(false);
  });
  it("falha fechada se a leitura da autoridade falhar", async () => {
    mocks.row.mockResolvedValue({ data: null, error: { message: "conteúdo sensível de teste" } });
    const result = await requireExtensionPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).not.toContain("sensível");
    }
  });
});

describe("corpo limitado e resultado incerto", () => {
  it("lê documento válido no limite real", async () => {
    expect(new TextDecoder().decode(await readExtensionBody(request('{"a":1}'), 7))).toBe(
      '{"a":1}',
    );
  });
  it("recusa bytes excedentes sem confiar em Content-Length", async () => {
    const headersCases: Array<Record<string, string>> = [{}, { "content-length": "1" }];
    for (const headers of headersCases) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345678"));
        },
        cancel() {
          cancelled = true;
        },
      });
      await expect(readExtensionBody(request(stream, headers), 7)).rejects.toMatchObject({
        code: "extension_payload_too_large",
      });
      expect(cancelled).toBe(true);
    }
  });
  it("prazo termina também um corpo com JSON completo cuja conexão não fecha", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reading = readExtensionBody(request(stream), 100);
    const rejected = expect(reading).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(cancelled).toBe(true);
  });
  it("recusa compressed ou formulário antes de materializar o corpo", async () => {
    await expect(
      readExtensionBody(request("{}", { "content-encoding": "gzip" }), 100),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readExtensionBody(request("{}", { "content-type": "text/plain" }), 100),
    ).rejects.toMatchObject({ status: 415 });
  });
  it("exige UUID do pedido e não fabrica um novo na repetição", () => {
    expect(() => operationKey(request("{}"))).toThrow();
    const id = "b8a5e2a0-2c5a-4c88-b35d-2ccf0c09ddcd";
    expect(operationKey(request("{}", { "Idempotency-Key": id }))).toBe(id);
  });
  it("erro desconhecido pede reconciliação sem vazar corpo remoto", async () => {
    const result = extensionFailure(new Error("segredo ou corpo do catálogo"));
    expect(result.status).toBe(503);
    const body = await result.text();
    expect(body).toContain("histórico");
    expect(body).not.toContain("segredo");
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("segredo");
  });
});
