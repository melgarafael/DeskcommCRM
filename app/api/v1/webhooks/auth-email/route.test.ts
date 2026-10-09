import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  audit: vi.fn(),
  marca: vi.fn(),
  reservar: vi.fn(),
  concluir: vi.fn(),
  liberar: vi.fn(),
  rate: vi.fn(),
  logger: vi.fn(),
  env: {
    AUTH_EMAIL_HOOK_SECRET: "",
    NEXT_PUBLIC_APP_URL: "https://app.example.test",
    NEXT_PUBLIC_SUPABASE_URL: "https://auth.example.test",
  },
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: mocks.marca,
  NEUTROS_DE_SAIDA: { fundo: "#fff", texto: "#111", suave: "#444" },
}));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: mocks.send }));
vi.mock("@/lib/email/recibo-auth", () => ({
  criarRecibosAuth: () => ({ reservar: mocks.reservar }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));
vi.mock("@/lib/logger", () => ({ logger: { error: mocks.logger } }));
import { POST } from "./route";

const chave = Buffer.alloc(32, 9);
const payload = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "teste@example.test" },
  email_data: {
    email_action_type: "signup",
    token_hash: "hash-sintetico",
    site_url: "https://auth.example.test",
    redirect_to: "https://app.example.test/auth/confirm?type=signup",
  },
};
function request(body: unknown = payload, assinado = true) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const assinatura = createHmac("sha256", chave)
    .update(`msg_teste.${timestamp}.${raw}`)
    .digest("base64");
  return new Request("https://app.example.test/api/v1/webhooks/auth-email", {
    method: "POST",
    body: raw,
    headers: assinado
      ? {
          "webhook-id": "msg_teste",
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${assinatura}`,
        }
      : {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.AUTH_EMAIL_HOOK_SECRET = `v1,whsec_${chave.toString("base64")}`;
  mocks.marca.mockResolvedValue({
    nome: "Instalação",
    logoUrl: null,
    accent: "#ab5498",
    accentFg: "#fff",
  });
  mocks.send.mockResolvedValue({ ok: true, via: "smtp" });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.reservar.mockResolvedValue({
    estado: "reservado",
    concluir: mocks.concluir,
    liberar: mocks.liberar,
  });
});
describe("Send Email Hook", () => {
  it("sem configuração ou assinatura não envia", async () => {
    mocks.env.AUTH_EMAIL_HOOK_SECRET = "";
    expect((await POST(request())).status).toBe(503);
    mocks.env.AUTH_EMAIL_HOOK_SECRET = `v1,whsec_${chave.toString("base64")}`;
    expect((await POST(request(payload, false))).status).toBe(401);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("recusa corpo grande, JSON e payload inválidos antes do efeito", async () => {
    expect((await POST(request("x".repeat(65537)))).status).toBe(413);
    expect((await POST(request("{"))).status).toBe(400);
    expect(
      (await POST(request({ ...payload, email_data: { email_action_type: "desconhecido" } })))
        .status,
    ).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("envia e registra recibo/auditoria sem email ou token", async () => {
    const r = await POST(request());
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Request-Id")).toBeTruthy();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.concluir).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.email_sent", organizationId: null }),
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/teste@example|hash-sintetico/);
  });
  it("replay concluído não envia novamente; concorrência pede retentativa", async () => {
    mocks.reservar.mockResolvedValueOnce({ estado: "enviado" });
    expect((await POST(request())).status).toBe(200);
    mocks.reservar.mockResolvedValueOnce({ estado: "ocupado" });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("recibo indisponível e teto de envio não falham abertos", async () => {
    mocks.reservar.mockRejectedValueOnce(new Error("redis fora"));
    expect((await POST(request())).status).toBe(503);
    mocks.rate.mockResolvedValueOnce({ allowed: false });
    expect((await POST(request())).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("falha não vaza erro de transporte e libera recibo para nova tentativa", async () => {
    mocks.send.mockResolvedValue({ ok: false, details: "teste@example.test hash-sintetico" });
    const r = await POST(request());
    expect(r.status).toBe(503);
    expect(mocks.liberar).toHaveBeenCalledOnce();
    expect(mocks.concluir).not.toHaveBeenCalled();
    expect(await r.text()).not.toMatch(/teste@example|hash-sintetico/);
    expect(JSON.stringify(mocks.logger.mock.calls)).not.toMatch(/teste@example|hash-sintetico/);
  });
  it("retentativa parcial não duplica primeiro destinatário", async () => {
    mocks.reservar.mockResolvedValueOnce({ estado: "enviado" });
    const r = await POST(
      request({
        ...payload,
        user: { ...payload.user, new_email: "novo@example.test" },
        email_data: {
          ...payload.email_data,
          email_action_type: "email_change",
          token_hash_new: "hash-atual",
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]?.[0].to).toBe("novo@example.test");
  });
});
