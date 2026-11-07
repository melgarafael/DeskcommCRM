import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3876 (fatia 1) — a troca OBRIGATÓRIA do primeiro acesso.
 *
 * O que se prova aqui:
 * - a senha nova passa pela MESMA régua da recuperação (`resetPasswordSchema`);
 * - a action só age quando existe vínculo com `senha_provisoria = true` — quem
 *   entrou por convite não é afetado por ela;
 * - a marca é APAGADA depois da troca (senão o gate tranca a pessoa num laço),
 *   o snapshot de permissões é derrubado e a trilha registra o ato;
 * - a senha nunca aparece em audit nem em log.
 */
/** O evento que a action grava — tipo explícito para `mock.calls` não virar tupla vazia. */
type EventoDeAudit = {
  action: string;
  actorUserId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
};

const h = vi.hoisted(() => ({
  loadAuthUser: vi.fn(),
  updateUser: vi.fn(),
  audit: vi.fn(async (_e: EventoDeAudit) => undefined),
  invalidar: vi.fn(),
  adminUpdate: vi.fn(),
  limpaErro: null as null | { message: string; code?: string },
  redirect: vi.fn(),
  log: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: () => null }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: h.loadAuthUser }));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarUsuario: h.invalidar }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: h.log, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { updateUser: h.updateUser } })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        h.adminUpdate(payload);
        // Construtor encadeável do PostgREST: qualquer ordem de `.in`/`.eq`
        // resolve no mesmo resultado, e o `then` é o `await` da action.
        const passo = {
          in: () => passo,
          eq: () => passo,
          then: (resolve: (v: { error: unknown }) => unknown) =>
            Promise.resolve({ error: h.limpaErro }).then(resolve),
        };
        return passo;
      },
    }),
  }),
}));

import { trocarSenhaProvisoria } from "./trocarSenhaProvisoria";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const SENHA_NOVA = "MinhaSenha#2026";

function usuarioCom(senhaProvisoria: boolean | undefined, extra: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: "pessoa@empresa.test",
    full_name: "Pessoa",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [
      {
        organization_id: ORG,
        organization_name: "Empresa",
        role: "agent",
        org_status: "active",
        senha_provisoria: senhaProvisoria,
      },
    ],
    ...extra,
  };
}

const entrada = { password: SENHA_NOVA, password_confirm: SENHA_NOVA };

beforeEach(() => {
  vi.clearAllMocks();
  h.limpaErro = null;
  h.updateUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  h.loadAuthUser.mockResolvedValue(usuarioCom(true));
});

describe("trocarSenhaProvisoria — o gate do primeiro acesso", () => {
  it("troca a senha, apaga a marca, derruba o snapshot e leva para /app", async () => {
    const res = await trocarSenhaProvisoria(entrada);

    expect(res).toBeUndefined(); // redirect encerra o fluxo
    expect(h.updateUser).toHaveBeenCalledWith({ password: SENHA_NOVA });
    expect(h.adminUpdate).toHaveBeenCalledWith({ senha_provisoria: false });
    expect(h.invalidar).toHaveBeenCalledWith(USER_ID);
    expect(h.redirect).toHaveBeenCalledWith("/app");

    const evento = h.audit.mock.calls[0]![0];
    expect(evento.action).toBe("auth.password_change_completed");
    expect(evento.actorUserId).toBe(USER_ID);
    expect(evento.metadata).toEqual({ organizacoes: [ORG] });
    // NUNCA a senha na trilha.
    expect(JSON.stringify(evento.metadata)).not.toContain(SENHA_NOVA);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(SENHA_NOVA);
  });

  it("convidado (sem a marca) não é afetado: nem troca, nem audita", async () => {
    h.loadAuthUser.mockResolvedValue(usuarioCom(undefined));
    const res = await trocarSenhaProvisoria(entrada);
    expect(res).toMatchObject({ ok: false, error: "not_required" });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.invalidar).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sem sessão devolve session_expired", async () => {
    h.loadAuthUser.mockResolvedValue(null);
    const res = await trocarSenhaProvisoria(entrada);
    expect(res).toMatchObject({ ok: false, error: "session_expired" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("senha fraca é recusada pela régua da recuperação, antes de falar com o GoTrue", async () => {
    const res = await trocarSenhaProvisoria({ password: "senhafraca", password_confirm: "senhafraca" });
    expect(res).toMatchObject({ ok: false, error: "validation_error" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("senhas que não coincidem são recusadas", async () => {
    const res = await trocarSenhaProvisoria({ password: SENHA_NOVA, password_confirm: `${SENHA_NOVA}1` });
    expect(res).toMatchObject({ ok: false, error: "validation_error" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("repetir a senha atual é same_password — e a marca NÃO cai", async () => {
    h.updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: "New password should be different from the old password." },
    });
    const res = await trocarSenhaProvisoria(entrada);
    expect(res).toMatchObject({ ok: false, error: "same_password" });
    expect(h.adminUpdate).not.toHaveBeenCalled();
    expect(h.invalidar).not.toHaveBeenCalled();
  });

  it("falha do GoTrue audita auth.password_change_failed sem vazar mensagem crua", async () => {
    h.updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: `weird failure for ${SENHA_NOVA}`, code: "unexpected_failure" },
    });
    const res = await trocarSenhaProvisoria(entrada);
    expect(res).toMatchObject({ ok: false, error: "update_failed" });
    const evento = h.audit.mock.calls[0]![0];
    expect(evento.action).toBe("auth.password_change_failed");
    expect(JSON.stringify(evento.metadata)).not.toContain(SENHA_NOVA);
  });

  it("falha ao apagar a marca é declarada (não finge sucesso)", async () => {
    h.limpaErro = { message: "boom", code: "XX000" };
    const res = await trocarSenhaProvisoria(entrada);
    expect(res).toMatchObject({ ok: false, error: "update_failed" });
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.invalidar).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalled();
  });

  it("sessão de acompanhamento (suporte) nunca é obrigada a trocar", async () => {
    h.loadAuthUser.mockResolvedValue(
      usuarioCom(true, { support: { status: "active", organization_id: ORG, name: "Empresa", access_mode: "full" } }),
    );
    const res = await trocarSenhaProvisoria(entrada);
    expect(res).toMatchObject({ ok: false, error: "not_required" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });
});
