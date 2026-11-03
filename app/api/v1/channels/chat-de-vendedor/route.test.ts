import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  find: vi.fn(),
  save: vi.fn(),
  validar: vi.fn(),
  ligado: vi.fn(),
  encrypt: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: h.encrypt }));
vi.mock("@/lib/channels/chat-de-vendedor/session", () => ({
  findChatDeVendedorSession: h.find,
  saveChatDeVendedorSession: h.save,
}));
vi.mock("@/lib/channels/chat-de-vendedor/validate-credentials", () => ({
  validarCredencialChatDeVendedor: h.validar,
}));
vi.mock("@/lib/channels/chat-de-vendedor/credentials", () => ({
  canalChatDeVendedorLigado: h.ligado,
  CHAT_DE_VENDEDOR_LABEL: "Canal do vendedor",
}));

import { GET, POST } from "./route";

/**
 * A rota de conexão do canal do chat de vendedor (issue #2927). Canal
 * OPCIONAL da instalação, no molde do #1459: desligado, nenhuma das duas
 * responde — e 404 antes de perguntar o papel, para não delatar que a rota
 * existe.
 */
const URL_ = "https://crm.test/api/v1/channels/chat-de-vendedor";
const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const SESSAO = {
  id: "sess-1",
  sellerId: "seller-42",
  displayName: "Loja",
  status: "WORKING",
  webhookPathToken: "a".repeat(48),
  hasToken: true,
  archivedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: "org-confiavel" }, user: { id: "admin", idioma: "pt-BR" } });
  h.support.mockResolvedValue(null);
  h.encrypt.mockImplementation(async (_: unknown, v: string) => `enc(${v})`);
  h.find.mockResolvedValue(SESSAO);
  h.save.mockResolvedValue({ error: null, channelSessionId: "sess-1" });
  h.validar.mockResolvedValue({ ok: true, webhookRegistrado: true });
});

describe("desligado por padrão", () => {
  it("as duas respondem 404 e não chegam nem a perguntar o papel", async () => {
    // O interruptor em si (só `true` liga) é provado no teste do canal em
    // `tests/unit`; aqui, a rota o respeita.
    h.ligado.mockReturnValue(false);
    for (const r of [await GET(req("GET")), await POST(req("POST", { token: "x".repeat(30), seller_id: "seller-42" }))]) {
      expect(r.status).toBe(404);
    }
    expect(h.role).not.toHaveBeenCalled();
    expect(h.validar).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.encrypt).not.toHaveBeenCalled();
  });
});

describe("ligado", () => {
  beforeEach(() => {
    h.ligado.mockReturnValue(true);
  });

  it("GET exige admin e diz se há credencial, nunca qual é", async () => {
    const r = await GET(req("GET"));
    expect(r.status).toBe(200);
    expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
    const texto = JSON.stringify(await r.json());
    expect(texto).not.toContain("token-de-teste");
    expect(texto).not.toContain("enc(");
    const { data } = JSON.parse(texto);
    expect(data).toMatchObject({ label: "Canal do vendedor", connected: true, has_token: true, seller_id: "seller-42" });
    expect(data.webhook_url).toMatch(/\/api\/v1\/webhooks\/channel\/a{48}$/);
    expect(h.find).toHaveBeenCalledWith({}, "org-confiavel");
  });

  it("POST sem os dois campos recusa com 422 antes de falar com o provedor", async () => {
    const r = await POST(req("POST", { token: "x".repeat(30) }));
    expect(r.status).toBe(422);
    expect(h.validar).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("POST valida ANTES de gravar: token recusado não grava nada", async () => {
    h.validar.mockResolvedValue({ ok: false, motivo: "Token recusado pelo provedor." });
    const r = await POST(req("POST", { token: "x".repeat(30), seller_id: "seller-42" }));
    expect(r.status).toBe(422);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.encrypt).not.toHaveBeenCalled();
  });

  it("POST grava na organização da SESSÃO e registra o webhook com o token do path novo", async () => {
    h.find.mockResolvedValue(null);
    const r = await POST(req("POST", { token: "access-token" + "x".repeat(20), seller_id: "seller-9", organization_id: "org-do-corpo" }));
    expect(r.status).toBe(200);

    // O aperto de mão usou a URL do token que ESTE POST gerou — é ela que o
    // provedor vai entregar, e é ela que a rota devolve.
    const [validacao] = h.validar.mock.calls[0]! as [{ token: string; webhookUrl: string }];
    expect(validacao.webhookUrl).toMatch(/^https?:\/\/.+\/api\/v1\/webhooks\/channel\/[0-9a-f]{48}$/);
    const { data } = await r.json();
    expect(data.webhook_url).toBe(validacao.webhookUrl);

    // E a credencial foi CIFRADA antes de gravar, com a organização da sessão
    // (nunca a do corpo) e a conta de vendedor que o operador informou.
    expect(h.encrypt.mock.calls[0]![1]).toBe("access-token" + "x".repeat(20));
    const gravado = h.save.mock.calls[0]![1];
    expect(gravado).toMatchObject({
      organizationId: "org-confiavel",
      sellerId: "seller-9",
      tokenEncrypted: "enc(access-token" + "x".repeat(20) + ")",
      webhookPathToken: expect.stringMatching(/^[0-9a-f]{48}$/),
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.connected", organizationId: "org-confiavel" }),
    );
  });

  it("sem cifra disponível não grava token em claro", async () => {
    h.encrypt.mockResolvedValue(null);
    const r = await POST(req("POST", { token: "x".repeat(30), seller_id: "seller-42" }));
    expect(r.status).toBe(422);
    expect(h.save).not.toHaveBeenCalled();
  });
});
