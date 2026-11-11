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
}));

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
      },
    };
  },
}));

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
