import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bancoFalso, filtros, type BancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";
import { criarIntencaoDeContratacao } from "@/lib/cobranca/intencao-assinada";

const h = vi.hoisted(() => ({ banco: undefined as unknown as BancoFalso, role: "admin", support: null as unknown,
  status: "suspended", kind: "cobranca", first: true, paid: false, cancelada: false, intent: true, platformAdmin: false, scope: "full", mfa: vi.fn(), continuation: vi.fn() }));
const USER = "11111111-1111-4111-8111-111111111111";
let ORG: string;
const PLANO = "33333333-3333-4333-8333-333333333333";
vi.mock("next/navigation", () => ({ redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); } }));
vi.mock("@/lib/auth/server", () => ({ requireAuth: async () => ({ id: USER, idioma: "pt-BR", support: h.support, is_platform_admin: h.platformAdmin, platform_admin_scope: h.scope }),
  orgAtivaSemPortao: async () => ({ orgId: ORG, role: h.role, name: "Empresa de teste" }), exigirProvaDeMfa: h.mfa }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/cobranca/configuracao", () => ({ provedorDaInstalacao: async () => "asaas" }));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: vi.fn() }));
vi.mock("@/components/cobranca/ContinuarPagamento", () => ({ ContinuarPagamento: (p: unknown) => { h.continuation(p); return <div data-testid="continuar" />; } }));
import Page from "./page";
beforeEach(() => {
  vi.clearAllMocks(); h.role = "admin"; h.support = null; h.status = "suspended"; h.kind = "cobranca"; h.first = true; h.paid = false; h.intent = true;
  h.platformAdmin = false; h.scope = "full";
  h.cancelada = false;
  vi.stubEnv("INTERNAL_SECRET", "segredo-controlado-so-para-qa");
  const recibo = criarIntencaoDeContratacao(USER, PLANO, Date.now() - 1000)!;
  ORG = recibo.organization_id;
  h.banco = bancoFalso((q) => ({ data: q.tabela === "organizations"
    ? { status: h.status, suspended_kind: h.kind, cnpj: null, created_by: USER, created_at: new Date().toISOString() }
    : q.tabela === "cobranca_assinaturas"
      ? { plano_id: PLANO, estado: h.cancelada ? "cancelada" : h.paid ? "ativa" : "trial", pagamento_inicial_pendente: h.first, periodo_pago_desde: h.paid ? new Date().toISOString() : null, provedor: null, provedor_cliente_id: null }
      : q.tabela === "cobranca_planos"
        ? { id: PLANO, nome: "Plano anual", preco_cents: 1152000, intervalo: "ano" }
        : h.intent ? { id: ORG, created_at: new Date(Date.now() - 1000).toISOString(), metadata: { contratacao: recibo } } : null }));
});
const montar = async (params = {}) => render(await Page({ searchParams: Promise.resolve(params) }));
describe("primeira experiência de pagamento", () => {
  it("confirmação chega ao pagamento do plano anual, sem conta suspensa e sem escrita no GET", async () => {
    await montar();
    expect(screen.getByRole("heading", { name: "Continue sua contratação" })).toBeVisible();
    expect(screen.getByText(/11\.520,00.*pagamento anual de uma vez/)).toBeVisible();
    expect(screen.queryByText("Conta suspensa")).not.toBeInTheDocument();
    expect(h.continuation).toHaveBeenCalledWith(expect.objectContaining({ temIntencao: true, automatico: true, provedor: "asaas" }));
    expect(h.mfa).toHaveBeenCalledTimes(1);
    expect(h.banco.cadeias.every(q => q.passos.every(s => !["insert", "update", "delete"].includes(s.metodo)))).toBe(true);
    for (const q of h.banco.cadeias.filter(q => q.tabela === "cobranca_assinaturas")) expect(filtros(q)).toContainEqual(["eq", "organization_id", ORG]);
  });
  it.each([{ retomar: "1" }, { voltou: "1" }])("voltar do gateway não reabre pagamento em laço (%j)", async (params) => {
    await montar(params);
    expect(h.continuation).toHaveBeenCalledWith(expect.objectContaining({ automatico: false }));
  });
  it("conta existente sem intenção auditada só apresenta continuação manual", async () => {
    h.intent = false; await montar();
    expect(h.continuation).toHaveBeenCalledWith(expect.objectContaining({ temIntencao: false, automatico: false }));
  });
  it("cancelamento impede novo checkout automático mesmo com recibo ainda válido", async () => {
    h.cancelada = true; await montar();
    expect(h.continuation).toHaveBeenCalledWith(expect.objectContaining({ cancelada: true, temIntencao: false, automatico: false }));
  });
  it.each(["agent", "viewer"])("%s não ganha autoridade financeira", async role => {
    h.role = role; await expect(montar()).rejects.toThrow("REDIRECT:/account-suspended");
    expect(h.continuation).not.toHaveBeenCalled();
  });
  it("suporte não inicia contratação por conta do cliente", async () => {
    h.support = {}; await expect(montar()).rejects.toThrow("REDIRECT:/account-suspended");
  });
  it("dono pleno da plataforma fora do papel admin usa o mesmo gate MFA, sem voltar ao hub", async () => {
    h.platformAdmin = true; h.role = "agent"; await montar();
    expect(h.continuation).toHaveBeenCalled();
    expect(h.mfa).toHaveBeenCalledTimes(1);
  });
  it("plataforma somente leitura sem papel admin conserva o hub", async () => {
    h.platformAdmin = true; h.scope = "read_only"; h.role = "agent";
    await expect(montar()).rejects.toThrow("REDIRECT:/account-suspended");
  });
  it("poder pleno em modo suporte continua sem contratar", async () => {
    h.platformAdmin = true; h.role = "agent"; h.support = {};
    await expect(montar()).rejects.toThrow("REDIRECT:/account-suspended");
  });
  it("suspensão administrativa preserva o hub e a autoridade do administrador", async () => {
    h.kind = "administrativa"; await expect(montar()).rejects.toThrow("REDIRECT:/account-suspended");
  });
  it("inadimplência posterior não é rotulada primeira compra", async () => {
    h.first = false; await expect(montar()).rejects.toThrow("REDIRECT:/account-suspended");
  });
  it("org operante vai aos primeiros passos sem criar outro pagamento", async () => {
    h.status = "active"; h.paid = true; await expect(montar()).rejects.toThrow("REDIRECT:/onboarding/welcome");
    expect(h.continuation).not.toHaveBeenCalled();
  });
});
