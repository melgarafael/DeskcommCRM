/**
 * Issue #4313 — a tela "Definir nova senha" recusa senha acima de 72 BYTES
 * ANTES de falar com o GoTrue, e o erro do provedor deixa de ser genérico.
 *
 * Dois defeitos na mesma tela, medidos na main:
 *
 *   1. `resetPasswordSchema` não tinha teto, então a senha de 73 bytes passava
 *      no formulário, chegava ao GoTrue e voltava como "Não foi possível
 *      redefinir a senha. Tente novamente." — sem dizer que o problema era o
 *      tamanho. O teste de 73 bytes prova a recusa local: `createClient` não é
 *      chamado.
 *   2. Quando o erro do GoTrue chegava (`Password cannot be longer than 72
 *      characters`), a action caía em `update_failed`. Agora sai
 *      `password_too_long`, do mesmo jeito que `same_password`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";


const m = vi.hoisted(() => ({
  audit: vi.fn(),
  redirect: vi.fn(),
  createClient: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  getAal: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  /** Vínculos marcados que a sessão enxerga (#3876). */
  marcados: [] as Array<{ organization_id: string }>,
  adminUpdate: vi.fn(),
  adminIn: vi.fn(),
  adminEq: vi.fn(),
  adminErro: null as null | { code: string },
  invalidar: vi.fn(),
  logErro: vi.fn(),
}));

/** Cadeia do PostgREST que se resolve no `await` com o resultado dado. */
function cadeia(resultado: () => unknown, espioes: Record<string, (...a: unknown[]) => void> = {}) {
  const c: Record<string, unknown> = {
    then: (ok: (v: unknown) => void) => ok(resultado()),
  };
  for (const metodo of ["select", "update", "in", "eq"]) {
    c[metodo] = (...args: unknown[]) => {
      espioes[metodo]?.(...args);
      return c;
    };
  }
  return c;
}

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-4313" }),
}));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/auth/rate-limit", () => ({
  mfaBloqueadoPorFalhas: async () => false,
  registrarFalhaDeMfa: async () => undefined,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    m.createClient();
    return {
      auth: {
        getUser: m.getUser,
        updateUser: m.updateUser,
        mfa: { getAuthenticatorAssuranceLevel: m.getAal },
        signOut: m.signOut,
      },
      from: () => cadeia(() => ({ data: m.marcados, error: null })),
    };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () =>
      cadeia(() => ({ data: null, error: m.adminErro }), {
        update: m.adminUpdate,
        in: m.adminIn,
        eq: m.adminEq,
      }),
  }),
}));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarUsuario: m.invalidar }));
// Recuperação comum, sem acompanhamento: a regra `permanentAccessError` deixa passar.
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ support: null }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: m.logErro, warn: vi.fn(), info: vi.fn() } }));

const { updatePassword } = await import("./updatePassword");

/** A mesma frase da mensagem do schema — a chave do dicionário (pt → es). */
const MENSAGEM = "Senha longa demais: o limite é de 72 bytes";

/** 72 bytes exatos: 4 + 68 caracteres ASCII, um byte cada. */
const SENHA_72_BYTES = `Aa1!${"b".repeat(68)}`;
/** 73 bytes: um caractere ASCII acima do teto do bcrypt. */
const SENHA_73_BYTES = `${SENHA_72_BYTES}b`;

beforeEach(() => {
  vi.clearAllMocks();
  m.getUser.mockResolvedValue({ data: { user: { id: "u-ana" } }, error: null });
  m.getAal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1" } });
  m.updateUser.mockResolvedValue({ data: { user: { id: "u-ana" } }, error: null });
  m.marcados = [];
  m.adminErro = null;
});

describe("updatePassword — recuperação desliga a senha provisória (#3876)", () => {
  const SENHA = "Nova-senha-1";

  it("quem tinha a marca sai dela: escrita pelo servidor, só nos vínculos da própria pessoa", async () => {
    m.marcados = [{ organization_id: "org-a" }];
    await updatePassword({ password: SENHA, password_confirm: SENHA });

    expect(m.adminUpdate).toHaveBeenCalledWith({ senha_provisoria: false });
    expect(m.adminIn).toHaveBeenCalledWith("organization_id", ["org-a"]);
    expect(m.adminEq).toHaveBeenCalledWith("user_id", "u-ana");
    expect(m.invalidar).toHaveBeenCalledWith("u-ana");
    expect(m.redirect).toHaveBeenCalledWith("/login?reset=success");
  });

  it("sem marca, nada é escrito", async () => {
    await updatePassword({ password: SENHA, password_confirm: SENHA });
    expect(m.adminUpdate).not.toHaveBeenCalled();
    expect(m.redirect).toHaveBeenCalledWith("/login?reset=success");
  });

  it("falha ao limpar é registrada e não desfaz a recuperação", async () => {
    m.marcados = [{ organization_id: "org-a" }];
    m.adminErro = { code: "XX000" };
    await updatePassword({ password: SENHA, password_confirm: SENHA });
    expect(m.logErro).toHaveBeenCalled();
    expect(m.invalidar).not.toHaveBeenCalled();
    expect(m.redirect).toHaveBeenCalledWith("/login?reset=success");
  });

  it("senha recusada pelo GoTrue não mexe na marca", async () => {
    m.marcados = [{ organization_id: "org-a" }];
    m.updateUser.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await updatePassword({ password: SENHA, password_confirm: SENHA });
    expect(m.adminUpdate).not.toHaveBeenCalled();
  });
});

describe("updatePassword — teto de 72 bytes (issue #4313)", () => {
  it("recusa 73 bytes no schema, com a mensagem nova, sem chamar o GoTrue", async () => {
    expect(Buffer.byteLength(SENHA_73_BYTES, "utf8")).toBe(73);

    const res = await updatePassword({
      password: SENHA_73_BYTES,
      password_confirm: SENHA_73_BYTES,
    });

    expect(res).toMatchObject({ ok: false, error: "validation_error" });
    expect(res.details?.password).toContain(MENSAGEM);
    expect(m.createClient).not.toHaveBeenCalled();
    expect(m.updateUser).not.toHaveBeenCalled();
  });

  it("mapeia o erro de senha longa do GoTrue para password_too_long", async () => {
    m.updateUser.mockResolvedValue({
      data: { user: null },
      error: {
        message: "Password cannot be longer than 72 characters",
        code: "validation_failed",
        status: 400,
      },
    });

    // 72 bytes passam no schema e chegam ao provedor: é o caminho em que o
    // GoTrue ainda pode recusar (schema e versão do servidor divergem).
    const res = await updatePassword({
      password: SENHA_72_BYTES,
      password_confirm: SENHA_72_BYTES,
    });

    expect(res).toEqual({ ok: false, error: "password_too_long" });
    expect(m.updateUser).toHaveBeenCalledWith({ password: SENHA_72_BYTES });
  });

  it("same_password continua igual", async () => {
    m.updateUser.mockResolvedValue({
      data: { user: null },
      error: {
        message: "New password should be different from the old password.",
        code: "same_password",
        status: 422,
      },
    });

    const res = await updatePassword({
      password: SENHA_72_BYTES,
      password_confirm: SENHA_72_BYTES,
    });

    expect(res).toEqual({ ok: false, error: "same_password" });
  });
});
