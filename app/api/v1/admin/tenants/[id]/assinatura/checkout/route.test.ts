import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  escrita: vi.fn(),
  email: vi.fn(),
  ligada: true,
  provedor: "stripe" as string | null,
  ad: { lerSituacao: vi.fn(), garantirCliente: vi.fn(), iniciarAssinatura: vi.fn() },
  taxaOk: true,
  audit: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, loadAuthUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: h.escrita,
}));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: async (_db: unknown, modulo: string) => modulo === "cobranca" && h.ligada,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/cobranca/emails", () => ({ emailDoAdminDaEmpresa: h.email }));
vi.mock("@/lib/cobranca/configuracao", () => ({ provedorDaInstalacao: async () => h.provedor }));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: () => h.ad, modoDoProvedor: async () => "teste" }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: h.taxaOk }) }));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/requirePlatformAdmin";
import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const CNPJ = ["11", "222", "333", "0001", "81"].join("");
const EM_TESTE = {
  plano_id: "plano-a", estado: "trial", trial_ate: "2026-10-20T00:00:00.000Z", provedor: null, provedor_cliente_id: null,
  checkout_url: null, checkout_expira_em: null,
};
const FRASE_ISENTA = "Esta empresa é isenta: atribua um plano antes de gerar o link.";

let m: { linha: Record<string, unknown> | null; reservaOk: boolean };
function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: { legal_name: "Loja Legal Ltda", display_name: "Loja" } };
  if (c.tabela === "cobranca_planos") return { data: { id: "plano-a", nome: "Essencial", preco_cents: 4990, intervalo: "mes" } };
  if (operacao(c) === "select") return { data: m.linha };
  if (filtros(c).some((f) => f[0] === "or")) return m.reservaOk ? { data: { organization_id: TENANT } } : { data: null };
  return { data: { organization_id: TENANT } };
}

const ctx = (id = TENANT) => ({ params: Promise.resolve({ id }) });
const gerar = (corpo: Record<string, unknown> = {}, id = TENANT, chave = "3f1c2d4e-0000-4000-8000-000000000001") =>
  POST(
    new NextRequest(`http://localhost/api/v1/admin/tenants/${id}/assinatura/checkout`, {
      method: "POST",
      headers: { "Idempotency-Key": chave, "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
    ctx(id),
  );
const daAssinatura = () => h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas");
const updates = () => daAssinatura().filter((c) => operacao(c) === "update").map((c) => argumentos(c, "update")?.[0] as Record<string, unknown>);
const erro = async (res: Response) => ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.provedor = "stripe";
  h.taxaOk = true;
  m = { linha: { ...EM_TESTE }, reservaOk: true };
  h.banco = bancoFalso(responder);
  h.escrita.mockResolvedValue({
    user: { id: h.ator, email: "dono@instalacao.com" },
    platformAdmin: { user_id: h.ator, scope: "full", mfa_required: false },
  });
  h.email.mockResolvedValue("ana@loja.com");
  h.ad.garantirCliente.mockResolvedValue("cus_novo");
  h.ad.iniciarAssinatura.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_1", expiraEm: new Date("2026-10-11T12:00:00Z"), assinaturaRef: null });
});

describe("POST /admin/tenants/[id]/assinatura/checkout — Gerar link de pagamento (D-15)", () => {
  it("⭐ a org vem do path: toda cadeia de cobranca_assinaturas filtra organization_id; organization_id no corpo → 400", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockResolvedValue("cus_asaas_1");
    h.ad.iniciarAssinatura.mockResolvedValue({ url: "https://sandbox.asaas.com/i/pay_1", expiraEm: null, assinaturaRef: "sub_asaas_1" });
    const res = await gerar({ documento: CNPJ });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ url: "https://sandbox.asaas.com/i/pay_1" });
    // leitura, reserva, cliente do Asaas e fase 3
    expect(daAssinatura()).toHaveLength(4);
    for (const c of daAssinatura()) expect(filtros(c)).toContainEqual(["eq", "organization_id", TENANT]);
    const org = h.banco.cadeias.find((c) => c.tabela === "organizations")!;
    expect(filtros(org)).toEqual([["eq", "id", TENANT]]);
    expect(h.email).toHaveBeenCalledWith(h.banco.cliente, TENANT);

    h.banco = bancoFalso(responder);
    const intruso = await gerar({ organization_id: "cccccccc-0000-4000-8000-000000000001" });
    expect(intruso.status).toBe(400);
    expect((await erro(intruso)).code).toBe("validation_failed");
    expect(h.banco.cadeias).toEqual([]);
  });

  it("⭐ garantirCliente recebe o e-mail do admin da empresa, nunca o do dono, e o documento sem máscara", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockResolvedValue("cus_asaas_1");
    expect((await gerar({ documento: "11.222.333/0001-81" })).status).toBe(200);
    expect(h.ad.garantirCliente).toHaveBeenCalledWith({ id: TENANT, nome: "Loja Legal Ltda", email: "ana@loja.com", documento: CNPJ });
    expect(JSON.stringify(h.ad.garantirCliente.mock.calls)).not.toContain("dono@instalacao.com");
    const pedido = h.ad.iniciarAssinatura.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(pedido.urlDeVolta)).toMatch(/\/cobranca\/volta\?para=painel$/);
  });

  it("⭐ audit com actingAsPlatformAdmin e bypassedRls; documento fora do audit e de todo update", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockResolvedValue("cus_asaas_1");
    expect((await gerar({ documento: CNPJ })).status).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.checkout_iniciado",
      actorUserId: h.ator,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: TENANT,
      metadata: { provedor: "asaas", modo: "teste", plano_id: "plano-a" },
    }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(CNPJ);
    expect(JSON.stringify(updates())).not.toContain(CNPJ);
  });

  it("⭐ fatura aberta no provedor vira 200 com o link, sem iniciarAssinatura, e a reserva é liberada", async () => {
    m.linha = { ...EM_TESTE, provedor: "stripe", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 1, linkDePagamento: "https://invoice.stripe.com/i/x" });
    const res = await gerar();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ url: "https://invoice.stripe.com/i/x" });
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("link ainda válido: 200 com o mesmo link, sem provedor e sem audit", async () => {
    m.linha = { ...EM_TESTE, checkout_url: "https://checkout.stripe.com/c/pay/cs_0", checkout_expira_em: new Date(Date.now() + 3_600_000).toISOString() };
    const res = await gerar();
    expect((await res.json()).data).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_0" });
    expect(h.ad.lerSituacao).not.toHaveBeenCalled();
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sem fatura pagável: 409 sem_link_de_pagamento com a frase do dono", async () => {
    m.linha = { ...EM_TESTE, estado: "em_atraso", provedor: "stripe", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 1, linkDePagamento: null });
    const res = await gerar();
    expect(res.status).toBe(409);
    expect(await erro(res)).toEqual({
      code: "sem_link_de_pagamento",
      message: "A empresa já tem assinatura, mas não há cobrança aberta agora. Ela precisa atualizar o cartão em Plano e cobrança.",
    });
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });

  it("documento: dígito errado 422 sem cadeia de assinatura; Asaas sem cliente sem documento 422; Stripe sem documento 200", async () => {
    h.provedor = "asaas";
    const errado = await gerar({ documento: CNPJ.slice(0, 13) + "2" });
    expect(errado.status).toBe(422);
    expect((await erro(errado)).code).toBe("documento_invalido");
    expect(daAssinatura()).toEqual([]);

    const semDocumento = await gerar();
    expect(semDocumento.status).toBe(422);
    expect((await erro(semDocumento)).code).toBe("documento_obrigatorio");
    expect(updates()).toEqual([]);

    h.provedor = "stripe";
    expect((await gerar()).status).toBe(200);
    expect(h.ad.garantirCliente).toHaveBeenCalledWith(expect.objectContaining({ documento: null }));
  });

  it("sem admin com e-mail: 409 empresa_sem_email só quando o cliente vai ser criado, sem nenhum update; com cliente existente segue", async () => {
    h.email.mockResolvedValue(null);
    const res = await gerar();
    expect(res.status).toBe(409);
    expect((await erro(res)).code).toBe("empresa_sem_email");
    expect(updates()).toEqual([]);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();

    m.linha = { ...EM_TESTE, estado: "cancelada", provedor: "stripe", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 0, linkDePagamento: null });
    expect((await gerar()).status).toBe(200);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
    expect(h.ad.iniciarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ clienteRef: "cus_1" }));
  });

  it("leitura dos admins falhou: 500, sem tocar a assinatura", async () => {
    h.email.mockRejectedValue(new Error("admins ilegíveis (57014)"));
    const res = await gerar();
    expect(res.status).toBe(500);
    expect((await erro(res)).code).toBe("internal_error");
    expect(daAssinatura()).toEqual([]);
  });

  it("invalid_cpfCnpj → 422 documento_recusado; transitório → 503; os dois liberam a reserva", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockRejectedValue(new ErroDoProvedor(400, "invalid_cpfCnpj", false));
    const recusado = await gerar({ documento: CNPJ });
    expect(recusado.status).toBe(422);
    expect((await erro(recusado)).code).toBe("documento_recusado");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });

    h.banco = bancoFalso(responder);
    h.provedor = "stripe";
    h.ad.garantirCliente.mockResolvedValue("cus_novo");
    h.ad.iniciarAssinatura.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    const fora = await gerar();
    expect(fora.status).toBe(503);
    expect((await erro(fora)).code).toBe("provedor_indisponivel");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });

  it("recusa do provedor (chave revogada): 502 com a frase do dono, não 'fale com quem administra o sistema'", async () => {
    h.ad.iniciarAssinatura.mockRejectedValue(new ErroDoProvedor(401, "unauthorized", false, true));
    const res = await gerar();
    expect(res.status).toBe(502);
    expect(await erro(res)).toEqual({
      code: "provedor_recusou",
      message: "O provedor de pagamento recusou o pedido. Confira a chave em Cobrança › Conexão e tente de novo; o motivo aparece no painel do provedor.",
    });
  });

  it("rate limit → 429 com Retry-After 60, sem reservar", async () => {
    h.taxaOk = false;
    const res = await gerar();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect((await erro(res)).code).toBe("rate_limited");
    expect(updates()).toEqual([]);
  });

  it("nenhum provedor conectado: 409 com a frase do dono", async () => {
    h.provedor = null;
    const res = await gerar();
    expect(await erro(res)).toEqual({
      code: "provedor_nao_conectado",
      message: "Conecte o provedor de pagamento em Cobrança › Conexão antes de gerar o link.",
    });
  });
});

describe.each([
  ["módulo desligado", () => { h.ligada = false; }, TENANT, 404, "not_found"],
  ["id que não é UUID", () => {}, "x", 404, "not_found"],
  ["support_readonly", () => { h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura")); }, TENANT, 403, "forbidden_scope"],
  ["dívida de MFA", () => { h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("mfa_required", "prove o fator")); }, TENANT, 403, "mfa_required"],
] as const)("portão: %s", (_caso, preparar, id, status, codigo) => {
  it(`${status} ${codigo}, sem nenhuma cadeia no banco e sem provedor`, async () => {
    preparar();
    const res = await gerar({}, id);
    expect(res.status).toBe(status);
    expect((await erro(res)).code).toBe(codigo);
    expect(h.banco.cadeias).toEqual([]);
    expect(h.email).not.toHaveBeenCalled();
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });
});

describe("portões depois da identidade", () => {
  it("empresa isenta: 404 com a frase do dono; só a leitura da assinatura, nenhuma escrita", async () => {
    m.linha = null;
    const res = await gerar();
    expect(res.status).toBe(404);
    expect(await erro(res)).toEqual({ code: "not_found", message: FRASE_ISENTA });
    expect(daAssinatura().map(operacao)).toEqual(["select"]);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });

  it("Idempotency-Key que não é UUID: 400, sem cadeia", async () => {
    const res = await gerar({}, TENANT, "nao-e-uuid");
    expect(res.status).toBe(400);
    expect((await erro(res)).code).toBe("validation_error");
    expect(h.banco.cadeias).toEqual([]);
  });
});
