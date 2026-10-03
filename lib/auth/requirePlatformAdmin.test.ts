import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null, divida: false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => h.divida }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "pa-1" } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linha, error: null });
      return c;
    },
  }),
}));

import {
  EscritaDePlatformAdminNegada,
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "./requirePlatformAdmin";
import { escreveComoPlatformAdmin } from "./types";
import { escritaDeAdminOuRecusa } from "./escritaDeAdminOuRecusa";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "./recusa-de-escrita-de-admin";

const linha = (scope: string) => ({ user_id: "pa-1", scope, mfa_required: false, revoked_at: null });
async function recusa(): Promise<unknown> {
  return requirePlatformAdminEscrita().then(() => null, (e: unknown) => e);
}

beforeEach(() => {
  h.linha = null;
  h.divida = false;
});

describe("requirePlatformAdminEscrita", () => {
  it("full com sessão em dia passa e devolve o contexto", async () => {
    h.linha = linha("full");
    await expect(requirePlatformAdminEscrita()).resolves.toMatchObject({ platformAdmin: { scope: "full" } });
  });
  it("support_readonly é recusado com forbidden_scope", async () => {
    h.linha = linha("support_readonly");
    const e = await recusa();
    expect(e).toBeInstanceOf(EscritaDePlatformAdminNegada);
    expect(e).toMatchObject({ code: "forbidden_scope" });
  });
  it("full com MFA em dívida é recusado com mfa_required", async () => {
    h.linha = linha("full");
    h.divida = true;
    expect(await recusa()).toMatchObject({ code: "mfa_required" });
  });
  it("quem não é platform admin segue redirecionado, como em requirePlatformAdmin", async () => {
    expect(String(await recusa())).toContain("redirect:/admin/forbidden");
  });
  it("falhaDaEscritaDePlatformAdmin: recusa nomeada vira o seu código; o resto, forbidden", async () => {
    const a = falhaDaEscritaDePlatformAdmin(new EscritaDePlatformAdminNegada("forbidden_scope", "x"), "r1");
    expect(a.status).toBe(403);
    expect((await a.json()).error.code).toBe("forbidden_scope");
    const b = falhaDaEscritaDePlatformAdmin(new Error("redirect:/admin/forbidden"), "r2", "Só o dono.");
    expect(await b.json()).toMatchObject({ error: { code: "forbidden", message: "Só o dono." } });
  });
});

describe("escritaDeAdminOuRecusa — a recusa de server action é RESULTADO, não throw", () => {
  it("full em dia → ok com o contexto", async () => {
    h.linha = linha("full");
    await expect(escritaDeAdminOuRecusa()).resolves.toMatchObject({ ok: true, ctx: { platformAdmin: { scope: "full" } } });
  });
  it("support_readonly → {ok:false, error:'forbidden_scope'} (a tela lê o motivo, não o error boundary)", async () => {
    h.linha = linha("support_readonly");
    await expect(escritaDeAdminOuRecusa()).resolves.toEqual({ ok: false, error: "forbidden_scope" });
  });
  it("MFA em dívida → {ok:false, error:'mfa_required'}", async () => {
    h.linha = linha("full");
    h.divida = true;
    await expect(escritaDeAdminOuRecusa()).resolves.toEqual({ ok: false, error: "mfa_required" });
  });
  it("quem não é platform admin segue REDIRECIONADO (o throw do redirect não é engolido)", async () => {
    await expect(escritaDeAdminOuRecusa()).rejects.toThrow("redirect:/admin/forbidden");
  });
  it("a frase da tela é a mesma que o servidor lança, e só os dois códigos a têm", async () => {
    h.linha = linha("support_readonly");
    expect(await recusa()).toMatchObject({ message: MENSAGEM_DA_RECUSA_DE_ESCRITA.forbidden_scope });
    expect(ehRecusaDeEscrita("mfa_required")).toBe(true);
    expect(ehRecusaDeEscrita("write_failed")).toBe(false);
    expect(ehRecusaDeEscrita(undefined)).toBe(false);
  });
});

describe("escreveComoPlatformAdmin — o atalho de papel exige scope full", () => {
  it.each([
    [{ is_platform_admin: true, platform_admin_scope: "full" }, true],
    [{ is_platform_admin: true, platform_admin_scope: "support_readonly" }, false],
    [{ is_platform_admin: true, platform_admin_scope: null }, false],
    [{ is_platform_admin: true }, false],
    [{ is_platform_admin: false, platform_admin_scope: "full" }, false],
  ])("%o → %s (ausente = sem escrita)", (user, esperado) => {
    expect(escreveComoPlatformAdmin(user)).toBe(esperado);
  });
});
