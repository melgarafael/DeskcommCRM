import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PERFIL E IDIOMA NÃO DEVOLVEM O ERRO DO GOTRUE PARA O TOAST (#3747).
 *
 * ─── O defeito que este arquivo prende ───────────────────────────────────────
 *
 * `updateProfile` e `trocarIdioma` gravam em `auth.users` (metadata) e faziam
 * `return { ok: false, error: error.message }`. O que o GoTrue devolve nesse
 * caminho é texto de servidor: `JWT expired`, `invalid claim: missing sub
 * claim`, `duplicate key value violates unique constraint "users_..."`. Nada
 * disso diz a quem opera a tela o que fazer.
 *
 * Aqui o teste roda com `idioma: "es"` de propósito: a frase sai do dicionário,
 * no idioma de quem chamou — texto solto numa action não passaria por tradutor
 * nenhum e ficaria em português numa instalação em espanhol.
 *
 * ─── Sabotagem que confirma que a cerca vigia ───────────────────────────────
 *
 * Voltar `respostaParaOperador(...)` para `{ ok: false, error: error.message }`
 * deixa os dois casos ⭐ vermelhos — e o de espanhol mostra o texto do GoTrue
 * em vez da linha `es`.
 */

const USUARIO = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  erro: null as { code?: string; message: string } | null,
  metadata: [] as Record<string, unknown>[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarUsuario: () => undefined }));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: USUARIO, idioma: "es", support: null }),
  resolveActiveOrg: async () => ({ orgId: "33333333-3333-4333-8333-333333333333", role: "admin" }),
  mfaEmDivida: async () => false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      updateUser: async (payload: { data?: Record<string, unknown> }) => {
        h.metadata.push(payload.data ?? {});
        return { data: { user: null }, error: h.erro };
      },
    },
    // `updateProfile` emite `user.profile_updated` por `rpc` depois de gravar.
    rpc: async () => ({ data: null, error: null }),
  }),
}));

/** O que a tela não pode dizer, em nenhum desfecho. */
const VAZAMENTOS = ["error.message", "constraint", "relation", "violates"];

function semVazamento(resultado: { ok: boolean; error?: string }, erro: typeof h.erro) {
  const serializado = JSON.stringify(resultado);
  for (const proibido of VAZAMENTOS) expect(serializado.toLowerCase()).not.toContain(proibido);
  if (erro) expect(serializado).not.toContain(erro.message);
}

beforeEach(() => {
  h.erro = null;
  h.metadata.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("updateProfile", () => {
  const ENTRADA = { full_name: "Marcos", locale: "es", timezone: "America/Sao_Paulo" } as const;

  it("⭐ sessão vencida: frase de sessão em espanhol, sem o texto do GoTrue", async () => {
    h.erro = { message: "JWT expired" };

    const { updateProfile } = await import("@/app/actions/settings/updateProfile");
    const r = await updateProfile({ ...ENTRADA });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("Tu sesión expiró. Entra de nuevo.");
    semVazamento(r, h.erro);

    const log = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("JWT expired");
  });

  it("erro desconhecido cai na genérica traduzida — nunca no texto do servidor", async () => {
    h.erro = {
      message: 'duplicate key value violates unique constraint "users_email_partial_key"',
    };

    const { updateProfile } = await import("@/app/actions/settings/updateProfile");
    const r = await updateProfile({ ...ENTRADA });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("No se pudo guardar. Inténtalo de nuevo.");
    semVazamento(r, h.erro);
  });

  it("o caminho de sucesso continua igual: grava o metadata e devolve `{ ok: true }`", async () => {
    const { updateProfile } = await import("@/app/actions/settings/updateProfile");
    const r = await updateProfile({ ...ENTRADA });

    expect(r).toEqual({ ok: true });
    expect(h.metadata[0]).toMatchObject({ full_name: "Marcos", locale: "es" });
  });
});

describe("trocarIdioma", () => {
  it("⭐ falha de banco: frase do dicionário no idioma da sessão, com o cru no log", async () => {
    h.erro = { message: "Database error saving new user" };

    const { trocarIdioma } = await import("@/app/actions/settings/trocarIdioma");
    const r = await trocarIdioma("es");

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("No se pudo guardar. Inténtalo de nuevo.");
    semVazamento(r, h.erro);

    const log = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("Database error saving new user");
  });

  it("o caminho de sucesso continua devolvendo `{ ok: true }`", async () => {
    const { trocarIdioma } = await import("@/app/actions/settings/trocarIdioma");
    const r = await trocarIdioma("es");

    expect(r).toEqual({ ok: true });
    expect(h.metadata[0]).toMatchObject({ locale: "es" });
  });
});
