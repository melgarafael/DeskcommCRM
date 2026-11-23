import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Embedded Signup, rota: coexistência com o app WhatsApp Business.
 * - coexistência NÃO chama `/register` e marca `meta_coexistencia`;
 * - sem `phone_number_id`, o número vem de `/{waba}/phone_numbers`;
 * - mais de um número (ou nenhum) é recusado, sem gravar canal;
 * - o `/register` só roda DEPOIS de a gravação ser aceita, e o PIN é guardado.
 */

const gravar = vi.fn(async (_: unknown) => new Response(JSON.stringify({ data: { connected: true } }), { status: 200 }));
const mesclar = vi.fn(async (_org: string, _extra: Record<string, unknown>) => true);

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", role: "admin" },
  }),
}));
vi.mock("@/lib/channels/meta/app", () => ({
  embeddedSignupDaInstalacao: async () => ({ appId: "123456", configId: "654321" }),
  appDaMeta: async () => ({ appSecret: "segredo-de-teste" }),
}));
vi.mock("@/lib/channels/meta/gravar-canal-oficial", () => ({
  gravarCanalOficial: (i: unknown) => {
    chamadas.push("gravar");
    return gravar(i);
  },
  mesclarNoMetadataDoCanalOficial: (org: string, extra: Record<string, unknown>) => mesclar(org, extra),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "pin-cifrado" }));

import { POST } from "@/app/api/v1/channels/official/embedded-signup/route";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let chamadas: string[];
let numerosDaConta: Array<{ id: string }>;

beforeEach(() => {
  chamadas = [];
  numerosDaConta = [{ id: "555555" }];
  gravar.mockClear();
  mesclar.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: URL | string, init?: RequestInit) => {
      const url = String(entrada);
      chamadas.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.includes("/oauth/access_token")) return json({ access_token: "token-de-teste" });
      if (url.includes("/phone_numbers")) return json({ data: numerosDaConta });
      if (url.includes("/register")) return json({ success: true });
      return json({}, 404);
    }),
  );
});

const pedir = (corpo: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/v1/channels/official/embedded-signup", {
      method: "POST",
      body: JSON.stringify({ code: "codigo-de-teste-123", ...corpo }),
    }),
  );

describe("POST embedded-signup", () => {
  it("coexistência: busca o número pela conta, não registra e marca o canal", async () => {
    const r = await pedir({ waba_id: "222222", modo: "coexistencia" });
    expect(r.status).toBe(200);
    expect(chamadas.some((c) => c.includes("/register"))).toBe(false);
    expect(chamadas.some((c) => /^GET .*\/222222\/phone_numbers$/.test(c))).toBe(true);
    const entrada = gravar.mock.calls[0]![0] as { phoneNumberId: string; metadataExtra: Record<string, unknown> };
    expect(entrada.phoneNumberId).toBe("555555");
    expect(entrada.metadataExtra).toEqual({ meta_coexistencia: true });
  });

  it("coexistência com número no corpo: não consulta a conta nem registra", async () => {
    await pedir({ waba_id: "222222", phone_number_id: "777777", modo: "coexistencia" });
    expect(chamadas.some((c) => c.includes("/phone_numbers") || c.includes("/register"))).toBe(false);
    expect((gravar.mock.calls[0]![0] as { phoneNumberId: string }).phoneNumberId).toBe("777777");
  });

  it("modo padrão registra o número DEPOIS de gravar e guarda o PIN", async () => {
    await pedir({ waba_id: "222222", phone_number_id: "777777" });
    const registro = chamadas.findIndex((c) => c.includes("/register"));
    expect(registro).toBeGreaterThan(chamadas.indexOf("gravar"));
    const extra = (gravar.mock.calls[0]![0] as { metadataExtra: Record<string, unknown> }).metadataExtra;
    expect(extra).toEqual({ meta_coexistencia: false });
    expect(mesclar).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", {
      meta_registro_pin_cifrado: "pin-cifrado",
    });
  });

  it("gravação recusada (ex.: limite do plano): o número NÃO é registrado", async () => {
    gravar.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "plan_limit" } }), { status: 409 }));
    const r = await pedir({ waba_id: "222222", phone_number_id: "777777" });
    expect(r.status).toBe(409);
    expect(chamadas.some((c) => c.includes("/register"))).toBe(false);
    expect(mesclar).not.toHaveBeenCalled();
  });

  it("registro recusado pela Meta: a conexão segue e nenhum PIN é guardado", async () => {
    vi.mocked(fetch).mockImplementation(async (entrada: URL | string | Request) => {
      const url = String(entrada);
      chamadas.push(new URL(url).pathname);
      if (url.includes("/oauth/access_token")) return json({ access_token: "token-de-teste" });
      return json({ error: { message: "recusado" } }, 400);
    });
    const r = await pedir({ waba_id: "222222", phone_number_id: "777777" });
    expect(r.status).toBe(200);
    expect(chamadas.some((c) => c.includes("/register"))).toBe(true);
    expect(mesclar).not.toHaveBeenCalled();
  });

  it("mais de um número na conta: recusa e não grava", async () => {
    numerosDaConta = [{ id: "555555" }, { id: "666666" }];
    const r = await pedir({ waba_id: "222222", modo: "coexistencia" });
    expect(r.status).toBe(422);
    expect(gravar).not.toHaveBeenCalled();
  });

  it("nenhum número na conta: recusa e não grava", async () => {
    numerosDaConta = [];
    const r = await pedir({ waba_id: "222222", modo: "coexistencia" });
    expect(r.status).toBe(422);
    expect(gravar).not.toHaveBeenCalled();
  });

  it("sem waba_id: 422", async () => {
    const r = await pedir({ modo: "coexistencia" });
    expect(r.status).toBe(422);
  });
});
