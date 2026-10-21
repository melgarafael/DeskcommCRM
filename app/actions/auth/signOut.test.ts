/**
 * "SAIR" DESCONECTA TODOS OS APARELHOS — E OS AVISOS VÃO JUNTO.
 *
 * `supabase.auth.signOut()` sem `scope` é `global` no auth-js: a sessão cai em
 * todos os aparelhos da pessoa. Até aqui só a inscrição de push do aparelho que
 * clicou "Sair" era apagada (pelo cliente), e um aparelho já deslogado seguia
 * recebendo push da empresa — medido pela tela na prova do #3113.
 *
 * O dublê do admin devolve as linhas no tipo de produção (`Row` de
 * `push_subscriptions`): é o formato que o código lê para auditar por organização.
 */
import { AuthSessionMissingError, GoTrueClient, type User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/database.types";
import type { createClient } from "@/lib/supabase/server";

type ClienteDoServidor = Awaited<ReturnType<typeof createClient>>;
type LinhaApagada = Pick<Database["public"]["Tables"]["push_subscriptions"]["Row"], "organization_id">;
type RespostaDoDelete = { data: LinhaApagada[] | null; error: { message: string } | null };

const ordem: string[] = [];
const m = vi.hoisted(() => ({
  audit: vi.fn(),
  auditForOrganizations: vi.fn(),
  warn: vi.fn(),
  redirect: vi.fn(),
  deleteCookie: vi.fn(),
  filtros: [] as Array<[string, unknown]>,
  resposta: { data: [], error: null } as { data: unknown; error: { message: string } | null },
  signOut: vi.fn<ClienteDoServidor["auth"]["signOut"]>(),
  getUser: vi.fn<ClienteDoServidor["auth"]["getUser"]>(),
}));
const { signOut, getUser } = m;

const ana: User = {
  id: "u-ana",
  app_metadata: {},
  user_metadata: {},
  aud: "authenticated",
  created_at: "2026-10-20T00:00:00.000Z",
};

vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-1" }),
  cookies: async () => ({ delete: m.deleteCookie }),
}));
vi.mock("@/lib/audit", () => ({ audit: m.audit, auditForOrganizations: m.auditForOrganizations }));
vi.mock("@/lib/logger", () => ({ logger: { warn: m.warn } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: m.getUser, signOut: m.signOut } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      m.filtros.push(["tabela", tabela]);
      const q = {
        delete: () => q,
        eq: (coluna: string, valor: unknown) => {
          m.filtros.push([coluna, valor]);
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

import { signOut as sair } from "./signOut";

function responderDelete(r: RespostaDoDelete): void {
  m.resposta = r;
}

beforeEach(() => {
  ordem.length = 0;
  m.filtros.length = 0;
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: ana }, error: null });
  signOut.mockImplementation(async () => {
    ordem.push("signOut");
    return { error: null };
  });
  responderDelete({ data: [], error: null });
});

describe("signOut (Sair)", () => {
  it("premissa: no auth-js instalado, signOut() sem scope é global", () => {
    // Se o padrão virar `local`, "Sair" deixa os outros aparelhos logados e
    // apagar as inscrições de todos passa a ser largo demais — reveja o conserto.
    expect(GoTrueClient.prototype.signOut.toString()).toMatch(/scope:\s*["']global["']/);
  });

  it("apaga TODAS as inscrições da pessoa antes de encerrar a sessão, sem mudar o scope", async () => {
    responderDelete({
      data: [{ organization_id: "org-a" }, { organization_id: "org-b" }, { organization_id: "org-a" }],
      error: null,
    });
    await sair();
    expect(ordem).toEqual(["apagou", "signOut"]);
    // Só `user_id`: nenhum filtro por endpoint, que restringiria ao aparelho que saiu.
    expect(m.filtros).toEqual([
      ["tabela", "push_subscriptions"],
      ["user_id", "u-ana"],
    ]);
    expect(signOut).toHaveBeenCalledWith();
    expect(m.auditForOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_prefs.push_subscription_removed",
        actorUserId: "u-ana",
        requestId: "req-1",
        metadata: { channel: "web_push", escopo: "todos_os_aparelhos", removidas: 3 },
      }),
      ["org-a", "org-b"],
    );
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.logout", metadata: { scope: "global" } }),
    );
  });

  it("falha ao apagar → registra e sai do mesmo jeito", async () => {
    responderDelete({ data: null, error: { message: "fora" } });
    await sair();
    expect(m.warn).toHaveBeenCalledWith("push_subscriptions_signout_global_failed", expect.anything());
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(m.redirect).toHaveBeenCalledWith("/login");
  });

  it("sem sessão → não apaga nada e vai para o login", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    await sair();
    expect(m.filtros).toEqual([]);
    expect(m.redirect).toHaveBeenCalledWith("/login");
  });
});
