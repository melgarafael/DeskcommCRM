// A AÇÃO que grava a política de segundo fator (#1533, #2163): autorização,
// validação, gravação + auditoria, e entrada malformada RECUSADA em vez de
// lida como "desligar".
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  role: "admin" as string,
  settings: {} as Record<string, unknown>,
  updates: [] as unknown[],
  audits: [] as Array<Record<string, unknown>>,
  emDivida: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async (e: Record<string, unknown>) => { estado.audits.push(e); }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", is_platform_admin: false, support: null }),
  resolveActiveOrg: async () => ({ orgId: "o1", role: estado.role }),
  sessionAal: async () => "aal2",
  isMfaEnrolled: async () => true,
  mfaEmDivida: async () => estado.emDivida,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: estado.settings }, error: null }) }) }),
      update: (v: unknown) => ({ eq: async () => { estado.updates.push(v); return { error: null }; } }),
    }),
  }),
}));

import { definirExigenciaDeMfa } from "@/app/actions/auth/politicaDeMfa";

beforeEach(() => {
  estado.role = "admin";
  estado.settings = {};
  estado.updates = [];
  estado.audits = [];
  estado.emDivida = false;
});

describe("definirExigenciaDeMfa (#2163)", () => {
  it("quem não é admin é recusado e nada é gravado", async () => {
    estado.role = "manager";
    const r = await definirExigenciaDeMfa({ minRole: "agent", graceDays: 0 });
    expect(r.ok).toBe(false);
    expect(estado.updates).toHaveLength(0);
  });

  it("admin com fator NÃO provado nesta sessão é recusado também no nível mínimo e na carência", async () => {
    estado.emDivida = true;
    const r = await definirExigenciaDeMfa({ minRole: "agent", graceDays: 7 });
    expect(r.ok).toBe(false);
    expect(estado.updates).toHaveLength(0);
    expect(estado.audits).toHaveLength(0);
  });

  it("papel fora da lista e carência fora de 0..30 são recusados", async () => {
    expect((await definirExigenciaDeMfa({ minRole: "owner" as never, graceDays: 0 })).ok).toBe(false);
    expect((await definirExigenciaDeMfa({ minRole: "agent", graceDays: 31 })).ok).toBe(false);
    expect((await definirExigenciaDeMfa({ minRole: "agent", graceDays: 1.5 })).ok).toBe(false);
    expect(estado.updates).toHaveLength(0);
  });

  it("entrada que não é boolean nem objeto válido é RECUSADA, não vira 'desligar'", async () => {
    estado.settings = { security: { mfa_required: true, mfa_required_min_role: "agent", mfa_grace_days: 0 } };
    const r = await definirExigenciaDeMfa("admin" as never);
    expect(r.ok).toBe(false);
    expect(estado.updates).toHaveLength(0);
  });

  it("grava as três chaves + booleano legado, e audita anterior e novo", async () => {
    const r = await definirExigenciaDeMfa({ minRole: "agent", graceDays: 7 });
    expect(r.ok).toBe(true);
    const sec = (estado.updates[0] as { settings: { security: Record<string, unknown> } }).settings.security;
    expect(sec.mfa_required).toBe(true);
    expect(sec.mfa_required_min_role).toBe("agent");
    expect(sec.mfa_grace_days).toBe(7);
    expect(typeof sec.mfa_policy_changed_at).toBe("string");
    expect(estado.audits[0]?.action).toBe("security.mfa_exigida");
    expect(estado.audits[0]?.metadata).toEqual({
      papel_minimo_anterior: "none",
      papel_minimo_novo: "agent",
      dias_de_carencia_anterior: 0,
      dias_de_carencia_novo: 7,
    });
  });

  it("mesmo valor (legado true = admin) não regrava nem audita", async () => {
    estado.settings = { security: { mfa_required: true } };
    const r = await definirExigenciaDeMfa({ minRole: "admin", graceDays: 0 });
    expect(r.ok).toBe(true);
    expect(estado.updates).toHaveLength(0);
    expect(estado.audits).toHaveLength(0);
  });
});
