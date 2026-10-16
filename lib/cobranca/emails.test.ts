import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, valorDoFiltro, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ enviar: vi.fn(), aviso: vi.fn() }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: h.enviar }));
vi.mock("@/lib/branding/saida", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: async () => ({ nome: "Revenda", logoUrl: null, accent: "#336699", accentFg: "#ffffff", origens: { nome: "padrao", cor: "padrao" } }),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com/" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: vi.fn(), info: vi.fn() } }));

import { avisarTrocaDeChave, emailDoAdminDaEmpresa, enviarAvisoAosAdmins } from "./emails";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const TEXTO = { titulo: "Não identificamos o pagamento de 05/10", corpo: "Pague pelo link.", severidade: "warn" as const };

/** Forma do auth-js numa falha de rede/5xx: devolve, não lança. */
const FALHA_DO_AUTH = { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 503, code: undefined } };

function montar(responder: (c: Cadeia) => Resposta, { authFalhaPara = [] as string[] } = {}) {
  const banco = bancoFalso(responder);
  const admin = {
    ...banco.cliente,
    auth: {
      admin: {
        getUserById: async (id: string) =>
          authFalhaPara.includes(id) ? FALHA_DO_AUTH : { data: { user: { email: `${id}@exemplo.com` } }, error: null },
      },
    },
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

  it("o Auth falhou na leitura de um admin: os outros recebem mesmo assim (melhor esforço)", async () => {
    const { admin } = montar(() => ({ data: [{ user_id: "ana" }, { user_id: "bia" }] }), { authFalhaPara: ["ana"] });
    await enviarAvisoAosAdmins(admin, { id: ORG, idioma: "pt-BR" }, TEXTO, null);
    expect(h.enviar.mock.calls.map((c) => c[0].to)).toEqual(["bia@exemplo.com"]);
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

describe("emailDoAdminDaEmpresa (o e-mail do cliente quando o dono gera o link)", () => {
  /** Responde `platform_admins` com `donos` e `user_organizations` com `admins`. */
  const comDonos = (donos: string[], admins: (c: Cadeia) => string[]) =>
    montar((c) => ({ data: (c.tabela === "platform_admins" ? donos : admins(c)).map((user_id) => ({ user_id })) }));

  it("⭐ devolve o admin ativo mais antigo: a leitura ordena por created_at e filtra a org", async () => {
    const { admin, banco } = comDonos([], () => ["ana", "bia"]);
    expect(await emailDoAdminDaEmpresa(admin, ORG)).toBe("ana@exemplo.com");
    const leitura = banco.cadeias.find((c) => c.tabela === "user_organizations")!;
    expect(filtros(leitura)).toEqual([
      ["eq", "organization_id", ORG],
      ["eq", "role", "admin"],
      ["is", "revoked_at", null],
      ["eq", "provisional_until_handover", false],
    ]);
    expect(argumentos(leitura, "order")).toEqual(["created_at"]);
    expect(filtros(banco.cadeias.find((c) => c.tabela === "platform_admins")!)).toEqual([["is", "revoked_at", null]]);
  });

  it("⭐ vínculo provisório do dono não conta como admin da empresa: convite pendente → null (409 empresa_sem_email)", async () => {
    // O dono criou a empresa para outra pessoa: o único admin ativo é ele, provisório (fn_create_tenant_with_owner).
    // `platform_admins` vazio isola o filtro de provisório da exclusão dos donos.
    const { admin } = comDonos([], (c) => (valorDoFiltro(c, "eq", "provisional_until_handover") === false ? [] : ["dono"]));
    expect(await emailDoAdminDaEmpresa(admin, ORG)).toBeNull();
    // Os avisos da régua seguem chegando ao dono provisório.
    await enviarAvisoAosAdmins(admin, { id: ORG, idioma: "pt-BR" }, TEXTO, null);
    expect(h.enviar.mock.calls.map((c) => c[0].to)).toEqual(["dono@exemplo.com"]);
  });

  it("⭐ empresa criada antes da 0237: o vínculo do dono não é provisório e é o mais antigo, e mesmo assim fica de fora", async () => {
    const { admin } = comDonos(["dono"], () => ["dono", "cliente"]);
    expect(await emailDoAdminDaEmpresa(admin, ORG)).toBe("cliente@exemplo.com");
  });

  it("⭐ empresa antiga ainda não entregue: o único admin é o dono → null (409 empresa_sem_email)", async () => {
    const { admin } = comDonos(["dono"], () => ["dono"]);
    expect(await emailDoAdminDaEmpresa(admin, ORG)).toBeNull();
  });

  it("null quando nenhum admin tem e-mail", async () => {
    const { admin } = comDonos([], () => []);
    expect(await emailDoAdminDaEmpresa(admin, ORG)).toBeNull();
  });

  it("lança se a leitura dos admins falhar (quem chama decide; nunca um null que vira 'sem admin')", async () => {
    const { admin } = montar((c) => (c.tabela === "platform_admins" ? { data: [] } : { error: { code: "57014", message: "timeout" } }));
    await expect(emailDoAdminDaEmpresa(admin, ORG)).rejects.toThrow("admins ilegíveis (57014)");
  });

  it("⭐ o Auth falhou na leitura do admin mais antigo: lança, nunca grava o e-mail do segundo no provedor", async () => {
    const { admin } = montar((c) => ({ data: c.tabela === "platform_admins" ? [] : [{ user_id: "ana" }, { user_id: "bia" }] }), {
      authFalhaPara: ["ana"],
    });
    await expect(emailDoAdminDaEmpresa(admin, ORG)).rejects.toThrow("e-mail de admin ilegível (503)");
  });

  it("⭐ o Auth falhou na leitura do único admin: lança (500), nunca null (409 'sem admin com e-mail' falso)", async () => {
    const { admin } = montar((c) => ({ data: c.tabela === "platform_admins" ? [] : [{ user_id: "ana" }] }), { authFalhaPara: ["ana"] });
    await expect(emailDoAdminDaEmpresa(admin, ORG)).rejects.toThrow("e-mail de admin ilegível");
  });

  it("lança se a leitura dos donos falhar: sem ela, o e-mail do dono poderia ir para o provedor", async () => {
    const { admin } = montar((c) => (c.tabela === "platform_admins" ? { error: { code: "57014", message: "timeout" } } : { data: [{ user_id: "ana" }] }));
    await expect(emailDoAdminDaEmpresa(admin, ORG)).rejects.toThrow("donos ilegíveis (57014)");
  });
});
