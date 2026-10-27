import { beforeEach, describe, expect, it, vi } from "vitest";
import { argumentos, bancoFalso, operacao, type BancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";
import { criarIntencaoDeContratacao } from "@/lib/cobranca/intencao-assinada";

const h = vi.hoisted(() => ({ banco: undefined as unknown as BancoFalso, audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
import { ensureTenantForUser } from "./provision";

const U = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
const NATIVA = "33333333-3333-4333-8333-333333333333";
let recibo: ReturnType<typeof criarIntencaoDeContratacao>;
let vinculo: string | null;
let colisao: boolean;
const user = () => ({ id: U, email: "pessoa@example.test", user_metadata: { org_name: "Empresa fictícia", cobranca_plan_id: P, organization_id: "campo-editavel-ignorado" } });
const insercoes = () => h.banco.cadeias.filter(c => c.tabela === "organizations" && operacao(c) === "insert")
  .map(c => argumentos(c, "insert")?.[0] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("INTERNAL_SECRET", "segredo-controlado-so-para-qa");
  recibo = criarIntencaoDeContratacao(U, P); vinculo = null; colisao = false;
  h.banco = bancoFalso(c => {
    if (c.tabela === "api_audit_log") return { data: { metadata: { contratacao: recibo } } };
    if (c.tabela === "user_organizations" && operacao(c) === "select") return { data: vinculo ? { organization_id: vinculo } : null };
    if (c.tabela === "organizations" && operacao(c) === "insert") {
      const input = argumentos(c, "insert")?.[0] as Record<string, string>;
      return colisao ? { data: null, error: { code: "23505" } } : { data: { id: input.id ?? NATIVA, slug: input.slug } };
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
  it("colisão do UUID reservado não cria uma segunda empresa com outro UUID", async () => {
    colisao = true;
    await expect(ensureTenantForUser(user())).rejects.toThrow("slug exhausted");
    expect(insercoes()).toHaveLength(3);
    expect(insercoes().every(input => input.id === recibo!.organization_id)).toBe(true);
    expect(h.banco.cadeias.some(c => c.tabela === "user_organizations" && operacao(c) === "insert")).toBe(false);
  });
});
