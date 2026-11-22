import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ signup: vi.fn(), audit: vi.fn(), plano: "11111111-1111-4111-8111-111111111111", trial: 0, offered: true }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://crm.example.test" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signUp: h.signup } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: async () => "aberto" }));
vi.mock("@/lib/auth/rate-limit", () => ({ authRateLimited: async () => false, AUTH_LIMITS: { signup: {} } }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/cobranca/cadastro", () => ({ cadastroExigeEscolhaDePlano: () => false,
  lerPlanosDoCadastro: async () => ({ padraoId: h.plano, oferecidos: h.offered ? [{ id: h.plano, trial_dias: h.trial }] : [] }) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, hashEmail: () => "hash-de-teste" }));
import { signUp } from "./signUp";
import { verificarIntencaoDeContratacao } from "@/lib/cobranca/intencao-assinada";
const U = "22222222-2222-4222-8222-222222222222";
const entrada = () => ({ org_name: "Empresa fictícia", email: "teste@example.test", password: "SenhaTeste2026!", password_confirm: "SenhaTeste2026!", cobranca_plan_id: h.plano, continuar_pagamento: true });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("INTERNAL_SECRET", "segredo-controlado-so-para-qa"); h.trial = 0; h.offered = true;
  h.signup.mockResolvedValue({ data: { user: { id: U, identities: [{ id: "nova" }] }, session: null }, error: null });
});
const intencao = () => h.audit.mock.calls.find(c => c[0]?.action === "auth.signup_requested")?.[0]?.metadata?.contratacao;
describe("cadastro registra somente intenção autêntica validada", () => {
  it("assina intenção do plano pago e mantém confirmação obrigatória", async () => {
    expect(await signUp(entrada())).toEqual({ ok: true, sessao_ativa: false });
    expect(verificarIntencaoDeContratacao(intencao(), U, h.plano)).not.toBeNull();
    const data = h.signup.mock.calls[0]?.[0]?.options?.data;
    expect(data).toEqual({ org_name: "Empresa fictícia", cobranca_plan_id: h.plano });
  });
  it("sessão imediata preserva intenção, sem inventar e-mail a confirmar", async () => {
    h.signup.mockResolvedValue({ data: { user: { id: U, identities: [{ id: "nova" }] }, session: {} }, error: null });
    expect(await signUp(entrada())).toEqual({ ok: true, sessao_ativa: true });
    expect(intencao()).toBeTruthy();
  });
  it("resposta ofuscada de conta existente não ganha autorização de contratação", async () => {
    h.signup.mockResolvedValue({ data: { user: { id: U, identities: [] }, session: null }, error: null });
    expect(await signUp(entrada())).toEqual({ ok: true, sessao_ativa: false });
    expect(intencao()).toBeUndefined();
  });
  it("plano privado/retirado é recusado antes do GoTrue", async () => {
    h.offered = false; expect((await signUp(entrada())).ok).toBe(false);
    expect(h.signup).not.toHaveBeenCalled(); expect(intencao()).toBeUndefined();
  });
  it("sem intenção explícita, não transforma login posterior em nova cobrança", async () => {
    await signUp({ ...entrada(), continuar_pagamento: false }); expect(intencao()).toBeUndefined();
  });
  it("plano com teste grátis conserva jornada de onboarding", async () => {
    h.trial = 7; await signUp(entrada()); expect(intencao()).toBeUndefined();
  });
});
