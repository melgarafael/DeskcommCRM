import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, filtros, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ enviar: vi.fn(), aviso: vi.fn() }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: h.enviar }));
vi.mock("@/lib/branding/saida", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: async () => ({ nome: "Revenda", logoUrl: null, accent: "#336699", accentFg: "#ffffff", origens: { nome: "padrao", cor: "padrao" } }),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com/" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: vi.fn(), info: vi.fn() } }));

import { avisarTrocaDeChave, enviarAvisoAosAdmins } from "./emails";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const TEXTO = { titulo: "Não identificamos o pagamento de 05/10", corpo: "Pague pelo link.", severidade: "warn" as const };

function montar(responder: (c: Cadeia) => Resposta) {
  const banco = bancoFalso(responder);
  const admin = {
    ...banco.cliente,
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@exemplo.com` } }, error: null }) } },
  };
  return { admin: admin as never, banco };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enviar.mockResolvedValue({ ok: true, via: "smtp" });
});

describe("enviarAvisoAosAdmins", () => {
  it("⭐ um e-mail por admin ativo da empresa, com o link de pagamento no botão", async () => {
    const { admin, banco } = montar(() => ({ data: [{ user_id: "ana" }, { user_id: "bia" }] }));
    await enviarAvisoAosAdmins(admin, { id: ORG, idioma: "pt-BR" }, TEXTO, "https://invoice.stripe.com/i/x");
    expect(filtros(banco.cadeias[0]!)).toEqual([
      ["eq", "organization_id", ORG],
      ["eq", "role", "admin"],
      ["is", "revoked_at", null],
    ]);
    expect(h.enviar).toHaveBeenCalledTimes(2);
    expect(h.enviar.mock.calls.map((c) => c[0].to)).toEqual(["ana@exemplo.com", "bia@exemplo.com"]);
    expect(h.enviar.mock.calls[0]?.[0].html).toContain('href="https://invoice.stripe.com/i/x"');
    expect(h.enviar.mock.calls[0]?.[0].subject).toBe("Não identificamos o pagamento de 05/10 — Revenda");
  });

  it("sem link de pagamento, o botão abre Plano e cobrança", async () => {
    const { admin } = montar(() => ({ data: [{ user_id: "ana" }] }));
    await enviarAvisoAosAdmins(admin, { id: ORG, idioma: "pt-BR" }, TEXTO, null);
    expect(h.enviar.mock.calls[0]?.[0].html).toContain('href="https://crm.exemplo.com/app/settings/billing"');
  });

  it("⭐ SMTP recusou: não lança, registra sem o endereço", async () => {
    h.enviar.mockResolvedValue({ ok: false, error: "sender_rejected", via: "smtp" });
    const { admin } = montar(() => ({ data: [{ user_id: "ana" }] }));
    await expect(enviarAvisoAosAdmins(admin, { id: ORG, idioma: "pt-BR" }, TEXTO, null)).resolves.toBeUndefined();
    expect(h.aviso).toHaveBeenCalledWith("cobranca.email_nao_saiu", { organization_id: ORG, erro: "sender_rejected", via: "smtp" });
    expect(JSON.stringify(h.aviso.mock.calls)).not.toContain("@exemplo.com");
  });

  it("leitura dos admins falhou: não lança e não envia", async () => {
    const { admin } = montar(() => ({ error: { code: "57014", message: "timeout" } }));
    await expect(enviarAvisoAosAdmins(admin, { id: ORG, idioma: "pt-BR" }, TEXTO, null)).resolves.toBeUndefined();
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

describe("avisarTrocaDeChave", () => {
  it("os donos com acesso total recebem os 4 últimos da chave antiga e da nova — nunca a chave", async () => {
    const { admin, banco } = montar(() => ({ data: [{ user_id: "dono" }] }));
    await avisarTrocaDeChave(admin, { antigo: "1234", novo: "5678" });
    expect(filtros(banco.cadeias[0]!)).toEqual([["eq", "scope", "full"], ["is", "revoked_at", null]]);
    expect(h.enviar.mock.calls[0]?.[0].subject).toContain("…1234 → …5678");
    expect(h.enviar.mock.calls[0]?.[0].html).toContain('href="https://crm.exemplo.com/admin/cobranca"');
  });
});
