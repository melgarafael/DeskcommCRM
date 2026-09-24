import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  find: vi.fn(),
  save: vi.fn(),
  saveSecret: vi.fn(),
  validate: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  ligado: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: h.encrypt, decryptWebhookSecret: h.decrypt }));
vi.mock("@/lib/channels/graph-parceiro/session", () => ({
  findGraphPartnerSession: h.find,
  saveGraphPartnerSession: h.save,
  saveGraphPartnerSigningSecret: h.saveSecret,
}));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  canalGraphParceiroLigado: h.ligado,
  GRAPH_PARTNER_LABEL: "Parceiro",
}));
vi.mock("@/lib/channels/graph-parceiro/validate-credentials", () => ({
  validateGraphPartnerCredentials: h.validate,
}));

import { GET, PATCH, POST } from "./route";

/**
 * A rota do canal parceiro que espelha a Cloud API (recorte do #1130).
 * Canal OPCIONAL da instalação: desligado, nenhuma das três responde.
 */
const URL_ = "https://crm.test/api/v1/channels/graph-partner";
const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const SESSAO = {
  id: "sess-1",
  phoneNumberId: "PN",
  wabaId: "WABA",
  displayName: "Loja",
  phoneNumber: "+5531",
  status: "WORKING",
  webhookPathToken: "tok123456789",
  hasToken: true,
  webhookSecretEncrypted: "cifrado",
  archivedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: "org-confiavel" }, user: { id: "admin", idioma: "pt-BR" } });
  h.support.mockResolvedValue(null);
  h.encrypt.mockImplementation(async (_: unknown, v: string) => `enc(${v})`);
  h.decrypt.mockResolvedValue("whsec_do_painel_123456");
  h.find.mockResolvedValue(SESSAO);
  h.save.mockResolvedValue({ error: null, channelSessionId: "sess-1" });
  h.saveSecret.mockResolvedValue({ error: null });
});

describe("desligado por padrão", () => {
  it("as três respondem 404 e não chegam nem a perguntar o papel", async () => {
    // O interruptor em si (só `true` liga) é provado em
    // teste do canal "desligado por padrão" em `tests/unit/`; aqui, a rota o respeita.
    h.ligado.mockReturnValue(false);
    for (const r of [await GET(req("GET")), await POST(req("POST", { token: "x".repeat(30) })), await PATCH(req("PATCH", { signing_secret: "whsec_1234567890abcdef" }))]) {
      expect(r.status).toBe(404);
    }
    expect(h.role).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("ligado", () => {
  beforeEach(() => {
    h.ligado.mockReturnValue(true);
  });

  it("GET exige admin e diz que as credenciais existem, nunca quais são", async () => {
    const r = await GET(req("GET"));
    expect(r.status).toBe(200);
    expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
    const texto = JSON.stringify(await r.json());
    expect(texto).not.toContain("whsec_do_painel");
    expect(texto).not.toContain("cifrado");
    const { data } = JSON.parse(texto);
    expect(data).toMatchObject({ connected: true, has_token: true, has_signing_secret: true });
    expect(data.webhook_url).toMatch(/\/api\/v1\/webhooks\/channel\/tok123456789$/);
    expect(h.find).toHaveBeenCalledWith({}, "org-confiavel");
  });

  it("GET com o segredo provisório da conexão responde que ainda NÃO recebe", async () => {
    h.decrypt.mockResolvedValue("a".repeat(64));
    const { data } = await (await GET(req("GET"))).json();
    expect(data.has_signing_secret).toBe(false);
  });

  it("POST valida ANTES de gravar: token recusado não grava nada", async () => {
    h.validate.mockResolvedValue({ ok: false, motivo: "Token recusado." });
    const r = await POST(req("POST", { token: "x".repeat(30) }));
    expect(r.status).toBe(422);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("POST grava na organização da SESSÃO e o segredo provisório nunca é o do painel", async () => {
    h.find.mockResolvedValue(null);
    h.validate.mockResolvedValue({ ok: true, phoneNumberId: "PN", wabaId: "WABA", displayPhoneNumber: "5531", verifiedName: "Loja" });
    const r = await POST(req("POST", { token: "sk_live_" + "x".repeat(30), organization_id: "org-do-corpo" }));
    expect(r.status).toBe(200);
    const gravado = h.save.mock.calls[0]![1];
    expect(gravado.organizationId).toBe("org-confiavel");
    expect(gravado.segredoProvisorioCifrado).not.toContain("whsec_");
    expect(JSON.stringify(await r.json())).not.toContain("sk_live_");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.connected" }));
  });

  it("PATCH só aceita o segredo do painel e só com o número já conectado", async () => {
    expect((await PATCH(req("PATCH", { signing_secret: "a".repeat(40) }))).status).toBe(422);
    h.find.mockResolvedValue(null);
    expect((await PATCH(req("PATCH", { signing_secret: "whsec_1234567890abcdef" }))).status).toBe(409);
    h.find.mockResolvedValue(SESSAO);
    expect((await PATCH(req("PATCH", { signing_secret: "whsec_1234567890abcdef" }))).status).toBe(200);
    expect(h.saveSecret).toHaveBeenCalledWith({}, {
      organizationId: "org-confiavel",
      channelSessionId: "sess-1",
      secretEncrypted: "enc(whsec_1234567890abcdef)",
    });
  });
});
