/**
 * A TELA DE `/app` PEDE O USUÁRIO AO GOTRUE UMA VEZ SÓ.
 *
 * `loadAuthUser` chama `getUser()`, e `isMfaEnrolled` chamava `listFactors()` —
 * que, no auth-js 2.117, chama `getUser()` pela rede DE NOVO e só filtra
 * `user.factors`. Duas idas ao servidor de autenticação por tela, com a mesma
 * resposta. Agora as duas leem `sessaoDaRequisicao` (lib/auth/server.ts),
 * memoizada por requisição pelo `cache` do React.
 *
 * O `cache` do React só memoiza dentro do render do servidor (fora dele, o
 * dispatcher é nulo e a função roda direto), então o que este arquivo prova é a
 * parte que é NOSSA: os fatores saem do `getUser`, e o `listFactors` não é
 * chamado. A regra de "falha fechada" continua em
 * `tests/unit/mfa-leitura-falha-fechado.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("isMfaEnrolled", () => {
  it("isMfaEnrolled lê os fatores do getUser, sem a segunda ida do listFactors", async () => {
    const listFactors = vi.fn(async () => {
      throw new Error("listFactors faz uma segunda ida ao GoTrue");
    });
    const getUser = vi.fn(async () => ({
      data: {
        user: { id: USER_ID, factors: [{ id: "f1", factor_type: "totp", status: "verified" }] },
      },
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser, mfa: { listFactors } },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const { isMfaEnrolled } = await import("@/lib/auth/server");

    await expect(isMfaEnrolled()).resolves.toBe(true);
    expect(listFactors).not.toHaveBeenCalled();
    expect(getUser).toHaveBeenCalledTimes(1);
  });


  it("fator não verificado ou de outro tipo não conta — a mesma regra do listFactors", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: USER_ID,
              factors: [
                { id: "f1", factor_type: "totp", status: "unverified" },
                { id: "f2", factor_type: "phone", status: "verified" },
              ],
            },
          },
          error: null,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const { isMfaEnrolled } = await import("@/lib/auth/server");

    await expect(isMfaEnrolled()).resolves.toBe(false);
  });
});
