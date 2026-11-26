/**
 * Issue #4743, item 1 — a MESMA régua do login vale no aceite de convite.
 *
 * O aceite é a terceira porta que confere credencial de conta (aqui, o token
 * assinado). A página já tem teto por IP; o que faltava era a CONTA entrar na
 * conta — trocar de IP a cada tentativa devolvia o orçamento inteiro.
 *
 * O token é assinado de verdade (`signInviteToken`), então o teste atravessa a
 * verificação HMAC como em produção; o que se dubla é o Supabase e o convite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  aplicarConvite: vi.fn(),
  getUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: h.getUser } })),
}));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: h.aplicarConvite }));
vi.mock("@/lib/impersonate/support", () => ({
  permanentAccessError: () => false,
  readSupportContext: async () => null,
}));

import { signInviteToken } from "@/lib/auth/invite-token";
import { acceptInviteAction } from "./acceptInvite";

/** O payload do token — `exp` no futuro, senão a assinatura vence antes do teste. */
function convitePara(email: string): string {
  return signInviteToken({
    invite_id: crypto.randomUUID(),
    email,
    organization_id: "33333333-3333-4333-8333-333333333333",
    role: "agent",
    exp: Math.floor(Date.now() / 1000) + 86_400,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.aplicarConvite.mockResolvedValue({ ok: true });
  h.getUser.mockResolvedValue({ data: { user: { id: "u-convidada", email: null } } });
});

describe("acceptInviteAction — régua do bloqueio progressivo (issue #4743)", () => {
  it("conta trancada não aceita convite: responde rate_limited antes de abrir sessão nenhuma", async () => {
    const email = "trancada@empresa.test";
    const { registrarFalhaNaRegua } = await import("@/lib/auth/rate-limit");
    for (let i = 0; i < 10; i++) await registrarFalhaNaRegua(email);

    const res = await acceptInviteAction(convitePara(email));

    expect(res).toEqual({ ok: false, error: "rate_limited" });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.aplicarConvite).not.toHaveBeenCalled();
  });

  it("token apresentado por outra conta é falha da conta convidada e escala a régua", async () => {
    const email = "alvo@empresa.test";
    const token = convitePara(email);
    h.getUser.mockResolvedValue({ data: { user: { id: "u-intrusa", email: "intrusa@empresa.test" } } });

    const respostas: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await acceptInviteAction(token);
      respostas.push(res.ok ? "ok" : res.error);
    }

    expect(respostas).toEqual(Array(5).fill("email_mismatch"));
    const { bloqueioProgressivoDeConta, falhasNaJanelaDiaria } = await import("@/lib/auth/rate-limit");
    expect(await falhasNaJanelaDiaria(email)).toBe(5);
    expect(await bloqueioProgressivoDeConta(email)).toMatchObject({
      bloqueado: true,
      degrau: 1,
    });
    // E a 6ª tentativa já não chega ao Supabase.
    expect(await acceptInviteAction(token)).toEqual({ ok: false, error: "rate_limited" });
  });

  it("conta livre aceita o convite como antes", async () => {
    h.getUser.mockResolvedValue({
      data: { user: { id: "u-convidada", email: "livre@empresa.test" } },
    });
    const res = await acceptInviteAction(convitePara("livre@empresa.test"));
    expect(h.aplicarConvite).toHaveBeenCalledTimes(1);
    expect(h.redirect).toHaveBeenCalledWith("/app");
    expect(res).toBeUndefined();
  });
});
