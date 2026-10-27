import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { criarIntencaoDeContratacao } from "./intencao-assinada";
import { bancoFalso, filtros } from "@/tests/helpers/banco-falso-da-cobranca";
import { lerIntencaoDeContratacao, primeiroPagamentoPendente, VALIDADE_DA_INTENCAO_MS } from "./contratacao";

const USER = "11111111-1111-4111-8111-111111111111";
let ORG: string;
const PLANO = "33333333-3333-4333-8333-333333333333";
const AGORA = Date.parse("2026-10-27T12:00:00Z");
let org: Record<string, unknown>;
let assinatura: Record<string, unknown>;
let audit: Record<string, unknown> | null;
let erro = false;
function banco() {
  return bancoFalso((c) => ({
    data: c.tabela === "organizations" ? org : c.tabela === "cobranca_assinaturas" ? assinatura : audit,
    error: erro ? { message: "indisponível" } : null,
  }));
}
beforeEach(() => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-controlado-so-para-qa");
  org = { created_by: USER, created_at: new Date(AGORA - 60_000).toISOString(), status: "suspended", suspended_kind: "cobranca" };
  assinatura = { plano_id: PLANO, estado: "trial", pagamento_inicial_pendente: true, periodo_pago_desde: null };
  audit = { id: "44444444-4444-4444-8444-444444444444", created_at: new Date(AGORA - 120_000).toISOString(), metadata: { contratacao: criarIntencaoDeContratacao(USER, PLANO, AGORA - 120_000) } };
  ORG = (audit.metadata as { contratacao: { organization_id: string } }).contratacao.organization_id;
  erro = false;
});
describe("intenção auditada de continuar o cadastro", () => {
  it("preserva plano, pessoa e empresa e não faz escrita ou RPC", async () => {
    const db = banco();
    expect(await lerIntencaoDeContratacao(db.cliente as unknown as SupabaseClient, USER, ORG, AGORA)).toMatchObject({ planoId: PLANO });
    expect(filtros(db.cadeias[0]!)).toContainEqual(["eq", "id", ORG]);
    expect(filtros(db.cadeias[1]!)).toContainEqual(["eq", "organization_id", ORG]);
    const prova = filtros(db.cadeias[2]!);
    expect(prova).toContainEqual(["eq", "actor_user_id", USER]);
    expect(prova).toContainEqual(["eq", "action", "auth.signup_requested"]);
    expect(prova).toContainEqual(["eq", "metadata->contratacao->>plano_id", PLANO]);
    expect(db.cadeias.every((c) => c.passos.every((p) => !["insert", "update", "delete"].includes(p.metodo)))).toBe(true);
    expect(db.rpcs).toEqual([]);
  });
  it.each([
    ["outro criador", { created_by: ORG }],
    ["suspensão administrativa", { suspended_kind: "administrativa" }],
    ["empresa operante", { status: "active" }],
    ["empresa anterior ao pedido", { created_at: new Date(AGORA - 3_600_000).toISOString() }],
  ])("%s não transforma o login em cobrança", async (_nome, delta) => {
    Object.assign(org, delta);
    expect(await lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, ORG, AGORA)).toBeNull();
  });
  it("outra empresa da mesma pessoa e plano não herda o aceite original", async () => {
    expect(await lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, "55555555-5555-4555-8555-555555555555", AGORA)).toBeNull();
  });
  it.each([
    ["paga", { estado: "ativa" }],
    ["período já pago", { periodo_pago_desde: "2026-10-01" }],
    ["sem flag inicial", { pagamento_inicial_pendente: false }],
  ])("%s não é primeiro pagamento", async (_nome, delta) => {
    Object.assign(assinatura, delta);
    expect(await lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, ORG, AGORA)).toBeNull();
  });
  it("metadata editável sem recibo auditado não vale como intenção", async () => {
    audit = null;
    expect(await lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, ORG, AGORA)).toBeNull();
  });
  it.each([
    ["plano diferente", { contratacao: { versao: 1, plano_id: ORG } }],
    ["versão desconhecida", { contratacao: { versao: 2, plano_id: PLANO } }],
    ["sem intenção", {}],
  ])("recibo %s não cria checkout", async (_nome, metadata) => {
    audit!.metadata = metadata;
    expect(await lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, ORG, AGORA)).toBeNull();
  });
  it.each([AGORA + 1, AGORA - VALIDADE_DA_INTENCAO_MS - 1])("recibo fora da janela (%s) não cria checkout", async (data) => {
    audit!.metadata = { contratacao: criarIntencaoDeContratacao(USER, PLANO, data) };
    expect(await lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, ORG, AGORA)).toBeNull();
  });
  it("falha de leitura fecha o caminho, sem inventar intenção", async () => {
    erro = true;
    await expect(lerIntencaoDeContratacao(banco().cliente as unknown as SupabaseClient, USER, ORG, AGORA)).rejects.toThrow("indisponível");
  });
  it("ausência de assinatura não é pagamento inicial pendente", () => expect(primeiroPagamentoPendente(null)).toBe(false));
});
