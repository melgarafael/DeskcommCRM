/**
 * `scripts/bootstrap-owner.ts` sobre um banco que JÁ tem o dono.
 *
 * O defeito que este teste guarda: o script sobrescrevia a senha do dono com o
 * OWNER_PASSWORD do .env toda vez que rodava. Quem re-rodava o bootstrap com um
 * .env de senha antiga (ou de placeholder) perdia o acesso que tinha — e sem
 * aviso nenhum, porque o log dizia só "senha atualizada".
 *
 * O que faz disso um defeito, e não uma escolha: o script é documentado como
 * "o que o install.sh faz" (CLAUDE.md, docs/testing/HANDOFF-vps-qa.md), e o
 * install.sh faz o OPOSTO. Medido contra o GoTrue v2.194.0 local: o
 * POST /auth/v1/admin/users do instalador responde 422 `email_exists` e a senha
 * anterior continua entrando; só o PUT/updateUserById daqui trocava.
 *
 * A asserção é sobre a CHAMADA à admin API, não sobre o log: é o que o usuário
 * sente. Sabote removendo o `if (!RESET_SENHA)` do script e o 1º caso reprova.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "dono@empresa.local";

const updateUserById = vi.fn(async () => ({ data: {}, error: null }));
const createUser = vi.fn(async () => ({
  data: { user: { id: OWNER_ID } },
  error: null,
}));

/**
 * Encadeador preguiçoso: qualquer método devolve a si mesmo e o objeto é
 * "thenable", então tanto `.select().eq().maybeSingle()` quanto o
 * `await .update().eq().eq()` do script resolvem no mesmo resultado. Ele
 * responde "a linha já existe" para org, membership e platform_admin — que é
 * exatamente o cenário sob prova: a 2ª execução, num banco já povoado.
 */
function chainJaExiste(): unknown {
  const linha = { data: { id: "org-1", user_id: OWNER_ID } };
  const chain: unknown = new Proxy(
    {},
    {
      get(_alvo, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
            Promise.resolve(linha).then(ok, erro);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: {
        listUsers: async () => ({
          data: { users: [{ id: OWNER_ID, email: OWNER_EMAIL }] },
        }),
        createUser,
        updateUserById,
      },
    },
    from: () => chainJaExiste(),
  }),
}));

/** Roda o script inteiro (ele chama main() no import) e espera terminar. */
async function rodarBootstrap(argv: string[]): Promise<void> {
  const argvOriginal = process.argv;
  process.argv = ["node", "scripts/bootstrap-owner.ts", ...argv];
  const logs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  try {
    vi.resetModules();
    await import("../../scripts/bootstrap-owner");
    // main() não é aguardado pelo módulo; o fim dele é a última linha do log.
    await vi.waitFor(() =>
      expect(logs.some((l) => l.includes("Bootstrap completo"))).toBe(true),
    );
  } finally {
    log.mockRestore();
    process.argv = argvOriginal;
  }
}

describe("bootstrap-owner: dono que já existe", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-de-mentira");
    vi.stubEnv("OWNER_EMAIL", OWNER_EMAIL);
    vi.stubEnv("OWNER_PASSWORD", "SenhaNovaDoEnv!2026");
    updateUserById.mockClear();
    createUser.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("por padrão NÃO mexe na senha (igual ao install.sh)", async () => {
    await rodarBootstrap([]);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("só redefine com --reset-owner-password, e com a senha do .env", async () => {
    await rodarBootstrap(["--reset-owner-password"]);
    expect(updateUserById).toHaveBeenCalledWith(OWNER_ID, {
      password: "SenhaNovaDoEnv!2026",
    });
  });
});
