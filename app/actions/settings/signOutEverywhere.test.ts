/**
 * "Sair de todos os dispositivos" apaga, no servidor, todas as inscrições de
 * push da pessoa (todas as organizações) antes de encerrar as sessões, e
 * audita em cada organização afetada. Falha nesse passo não impede a saída.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ordem: string[] = [];
const m = vi.hoisted(() => ({
  audit: vi.fn(),
  auditForOrganizations: vi.fn(),
  signOut: vi.fn(),
  warn: vi.fn(),
  redirect: vi.fn(),
  esquecer: vi.fn(),
  filtros: [] as Array<[string, unknown]>,
  resposta: { data: [] as unknown, error: null as { message: string } | null },
}));

vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-request-id": "req-1" }) }));
vi.mock("@/lib/audit", () => ({ audit: m.audit, auditForOrganizations: m.auditForOrganizations }));
vi.mock("@/lib/logger", () => ({ logger: { warn: m.warn } }));
vi.mock("@/lib/auth/dispositivo-confiavel", () => ({ esquecerDispositivosConfiaveis: m.esquecer }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u-ana" } } }),
      signOut: m.signOut,
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      m.filtros.push(["tabela", tabela]);
      const q = {
        delete: () => q,
        eq: (c: string, v: unknown) => {
          m.filtros.push([c, v]);
          return q;
        },
        select: async () => {
          ordem.push("apagou");
          return m.resposta;
        },
      };
      return q;
    },
  }),
}));

import { signOutEverywhere } from "./signOutEverywhere";

beforeEach(() => {
  ordem.length = 0;
  m.filtros.length = 0;
  vi.clearAllMocks();
  m.signOut.mockImplementation(async () => {
    ordem.push("signOut");
    return { error: null };
  });
  m.resposta = { data: [], error: null };
  m.esquecer.mockImplementation(async () => {
    ordem.push("esqueceu");
  });
});

describe("signOutEverywhere", () => {
  it("apaga as inscrições da pessoa ANTES de encerrar as sessões e audita por organização", async () => {
    m.resposta = {
      data: [{ organization_id: "org-a" }, { organization_id: "org-b" }, { organization_id: "org-a" }],
      error: null,
    };
    await signOutEverywhere();
    expect(ordem).toEqual(["apagou", "esqueceu", "signOut"]);
    expect(m.esquecer).toHaveBeenCalledWith("u-ana");
    expect(m.filtros).toEqual([
      ["tabela", "push_subscriptions"],
      ["user_id", "u-ana"],
    ]);
    expect(m.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(m.auditForOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_prefs.push_subscription_removed",
        actorUserId: "u-ana",
        resourceType: "push_subscription",
        metadata: { channel: "web_push", escopo: "todos_os_aparelhos", removidas: 3 },
      }),
      ["org-a", "org-b"],
    );
  });

  it("nada a apagar → sem auditoria de push", async () => {
    await signOutEverywhere();
    expect(m.auditForOrganizations).not.toHaveBeenCalled();
    expect(m.signOut).toHaveBeenCalledTimes(1);
  });

  it("falha ao apagar → registra e sai do mesmo jeito", async () => {
    m.resposta = { data: null, error: { message: "fora" } };
    await signOutEverywhere();
    expect(m.warn).toHaveBeenCalledWith("push_subscriptions_signout_global_failed", expect.anything());
    expect(m.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.logout" }));
    expect(m.redirect).toHaveBeenCalledWith("/login");
  });

  it("falha ao esquecer os dispositivos confiáveis → registra e sai do mesmo jeito", async () => {
    m.esquecer.mockRejectedValue(new Error("fora"));
    await signOutEverywhere();
    expect(m.warn).toHaveBeenCalledWith("dispositivos_confiaveis_signout_global_failed", expect.anything());
    expect(m.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(m.redirect).toHaveBeenCalledWith("/login");
  });
});
