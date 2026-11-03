/**
 * O limite de falhas do segundo fator vale nas DUAS actions que conferem o
 * código — `verifyMfa` (tela de login) e `updatePassword` (troca de senha numa
 * conta com verificação em duas etapas) — e as duas dividem o mesmo balde por
 * usuário.
 *
 * O limitador é o de verdade (contador em memória do processo, sem Upstash),
 * e o navegador nunca devolve o cookie `mfa_attempts`: o que barra a quarta
 * tentativa tem de ser o servidor. O que se dubla é só o Supabase (o código é
 * sempre recusado) e o que está em volta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = { verificacoes: 0 };

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  // Jar vazio a cada requisição: o cliente que não devolve o cookie.
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => ({
    get: (k: string) => (k === "x-forwarded-for" ? "198.51.100.7" : null),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/auth/dispositivo-confiavel", () => ({
  confiarNesteDispositivo: async () => {},
  DIAS_DE_CONFIANCA: 30,
}));

let usuario = "";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: usuario } }, error: null }),
      updateUser: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal2" },
        }),
        listFactors: async () => ({
          data: { totp: [{ id: "fator-1", status: "verified" }] },
        }),
        challenge: async () => ({ data: { id: "desafio-1" }, error: null }),
        verify: async () => {
          estado.verificacoes += 1;
          return { error: { message: "Invalid TOTP code entered" } };
        },
      },
    },
  }),
}));

const SENHA = { password: "Nova-senha-1", password_confirm: "Nova-senha-1", mfa_code: "000000" };

describe("o limite de falhas do segundo fator", () => {
  beforeEach(() => {
    vi.resetModules();
    estado.verificacoes = 0;
    usuario = crypto.randomUUID();
  });

  it("verifyMfa barra a quarta tentativa sem chegar a conferir o código", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await verifyMfa("000000")).error);

    expect(respostas).toEqual(["mfa_invalid", "mfa_invalid", "mfa_invalid", "mfa_locked"]);
    expect(estado.verificacoes).toBe(3);
  });

  it("updatePassword barra a quarta tentativa sem chegar a conferir o código", async () => {
    const { updatePassword } = await import("./updatePassword");
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await updatePassword(SENHA)).error);

    expect(respostas).toEqual(["mfa_invalid", "mfa_invalid", "mfa_invalid", "mfa_locked"]);
    expect(estado.verificacoes).toBe(3);
  });

  it("as duas telas contam no mesmo balde do usuário", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const { updatePassword } = await import("./updatePassword");
    for (let i = 0; i < 3; i++) await verifyMfa("000000");

    expect((await updatePassword(SENHA)).error).toBe("mfa_locked");
    expect(estado.verificacoes).toBe(3);
  });
});
