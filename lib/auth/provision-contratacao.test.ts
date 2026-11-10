import { beforeEach, describe, expect, it, vi } from "vitest";
import { argumentos, bancoFalso, operacao, valorDoFiltro, type BancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";
import { criarIntencaoDeContratacao } from "@/lib/cobranca/intencao-assinada";

const h = vi.hoisted(() => ({ banco: undefined as unknown as BancoFalso, audit: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { ensureTenantForUser } from "./provision";

const U = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
const NATIVA = "33333333-3333-4333-8333-333333333333";
let recibo: ReturnType<typeof criarIntencaoDeContratacao>;
let vinculo: string | null;
let colisao: boolean;
/** O que já ocupa o UUID reservado quando o INSERT devolve 23505. */
let reservada: { created_by: string } | null;
let vinculosDaReservada: Array<{ user_id: string; revoked_at: string | null }>;
/** Quantas inserções de empresa colidem antes de passar (Infinity = todas). */
let colisoes: number;
let auditoriaFalha: boolean;
const user = () => ({ id: U, email: "pessoa@example.test", user_metadata: { org_name: "Empresa fictícia", cobranca_plan_id: P, organization_id: "campo-editavel-ignorado" } });
const insercoes = () => h.banco.cadeias.filter(c => c.tabela === "organizations" && operacao(c) === "insert")
  .map(c => argumentos(c, "insert")?.[0] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("INTERNAL_SECRET", "segredo-controlado-so-para-qa");
  recibo = criarIntencaoDeContratacao(U, P); vinculo = null; colisao = false;
  reservada = null; vinculosDaReservada = []; colisoes = Infinity; auditoriaFalha = false;
  h.banco = bancoFalso(c => {
    if (c.tabela === "api_audit_log") {
      return auditoriaFalha ? { data: null, error: { code: "57014", message: "timeout" } } : { data: [{ metadata: { contratacao: recibo } }] };
    }
    if (c.tabela === "user_organizations" && operacao(c) === "select") {
      if (valorDoFiltro(c, "eq", "organization_id")) return { data: vinculosDaReservada };
      return { data: vinculo ? { organization_id: vinculo } : null };
    }
    if (c.tabela === "organizations" && operacao(c) === "select") {
      return { data: reservada ? { id: valorDoFiltro(c, "eq", "id"), slug: "empresa-ficticia", ...reservada } : null };
    }
    if (c.tabela === "organizations" && operacao(c) === "insert") {
      const input = argumentos(c, "insert")?.[0] as Record<string, string>;
      if (colisao && colisoes-- > 0) return { data: null, error: { code: "23505", message: "colisao sintetica de QA" } };
      return { data: { id: input.id ?? NATIVA, slug: input.slug } };
    }
    return { data: null };
  });
});

describe("primeira empresa da intenção assinada", () => {
  it("provisiona somente o UUID reservado pelo servidor, conserva membership e auditoria nativos", async () => {
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: true, organizationId: recibo!.organization_id });
    expect(insercoes()).toEqual([expect.objectContaining({ id: recibo!.organization_id, created_by: U, status: "active" })]);
    const membro = h.banco.cadeias.find(c => c.tabela === "user_organizations" && operacao(c) === "insert");
    expect(argumentos(membro!, "insert")?.[0]).toMatchObject({ user_id: U, organization_id: recibo!.organization_id, role: "admin" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.created_by_signup", organizationId: recibo!.organization_id }));
  });
  it("sem recibo válido conserva geração nativa de UUID, sem confiar na metadata", async () => {
    recibo = null;
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: true, organizationId: NATIVA });
    expect(insercoes()[0]).not.toHaveProperty("id");
  });
  it("leitura da intenção que falha não derruba o cadastro: empresa com UUID nativo, e o log registra", async () => {
    auditoriaFalha = true;
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: true, organizationId: NATIVA });
    expect(insercoes()[0]).not.toHaveProperty("id");
    expect(h.warn).toHaveBeenCalledWith("signup_provisioning.intencao_indisponivel", expect.objectContaining({ userId: U }));
  });
  it("adulterar o UUID do recibo não altera o UUID da empresa", async () => {
    recibo!.organization_id = NATIVA;
    await ensureTenantForUser(user());
    expect(insercoes()[0]).not.toHaveProperty("id");
  });
  it("usuário/plano diferentes não podem reaproveitar o UUID planejado", async () => {
    await ensureTenantForUser({ ...user(), id: NATIVA });
    expect(insercoes()[0]).not.toHaveProperty("id");
  });
  it("membership ativa existente continua idempotente e não lê intenção nem cria outra empresa", async () => {
    vinculo = NATIVA;
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: false, organizationId: NATIVA });
    expect(insercoes()).toEqual([]);
    expect(h.banco.cadeias.some(c => c.tabela === "api_audit_log")).toBe(false);
  });
  const membros = () => h.banco.cadeias.filter(c => c.tabela === "user_organizations" && operacao(c) === "insert")
    .map(c => argumentos(c, "insert")?.[0] as Record<string, unknown>);

  it("⭐ empresa da intenção criada antes e sem vínculo (o vínculo falhou): o retry a adota, sem segunda empresa", async () => {
    colisao = true; reservada = { created_by: U }; vinculosDaReservada = [];
    expect(await ensureTenantForUser(user(), { source: "recovery" })).toEqual({ provisioned: true, organizationId: recibo!.organization_id });
    expect(insercoes()).toHaveLength(1);
    expect(membros()).toEqual([expect.objectContaining({ user_id: U, organization_id: recibo!.organization_id, role: "admin" })]);
  });
  it("⭐ confirmação clicada duas vezes: a segunda devolve a mesma empresa, sem criar outra nem vincular de novo", async () => {
    colisao = true; reservada = { created_by: U }; vinculosDaReservada = [{ user_id: U, revoked_at: null }];
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: false, organizationId: recibo!.organization_id });
    expect(insercoes()).toHaveLength(1);
    expect(membros()).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("UUID reservado ocupado por empresa de outra pessoa: refaz sem o id reservado e não toca na alheia", async () => {
    colisao = true; colisoes = 1; reservada = { created_by: NATIVA };
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: true, organizationId: NATIVA });
    expect(insercoes()[0]).toHaveProperty("id", recibo!.organization_id);
    expect(insercoes()[1]).not.toHaveProperty("id");
    expect(membros()).toEqual([expect.objectContaining({ organization_id: NATIVA })]);
  });
  it("colisão só do slug (UUID reservado livre): troca o slug e mantém o UUID reservado", async () => {
    colisao = true; colisoes = 1; reservada = null;
    expect(await ensureTenantForUser(user())).toEqual({ provisioned: true, organizationId: recibo!.organization_id });
    expect(insercoes().map(i => i.id)).toEqual([recibo!.organization_id, recibo!.organization_id]);
    expect(insercoes()[1]!.slug).not.toBe(insercoes()[0]!.slug);
  });
});
