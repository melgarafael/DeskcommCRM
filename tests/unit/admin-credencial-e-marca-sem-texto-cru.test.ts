import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS TELAS DE CREDENCIAL E DE MARCA NÃO DEVOLVEM O TEXTO DO POSTGRES (#3747).
 *
 * ─── O defeito que este arquivo prende ───────────────────────────────────────
 *
 * `updateGoogleOAuth`, `updateMetaApp` e `updateBranding` faziam, cada uma,
 * `if (error) return { ok: false, error: error.message }` — e o `_form.tsx` joga
 * isso direto no toast. O relato de suporte que abriu a issue é literalmente a
 * mensagem do Postgres: `new row for relation "platform_branding" violates check
 * constraint "platform_branding_accent_hex"`.
 *
 * ─── O que o caso ⭐ mede ────────────────────────────────────────────────────
 *
 * O caminho de erro é o MESMO (o toast continua recebendo `{ ok: false, error }`
 * para a mesma falha de banco); o que muda é o texto: a frase do campo, com o
 * cru só no `logger.error`. A prova é `JSON.stringify(resultado)` sem
 * `error.message`, `constraint`, `relation` nem `violates` — e o log com o texto
 * inteiro, que é onde alguém consegue agir.
 *
 * ─── Sabotagem que confirma que a cerca vigia ───────────────────────────────
 *
 * Trocar o `respostaParaOperador(...)` de volta por `{ ok: false, error:
 * error.message }` deixa os três casos ⭐ vermelhos.
 */

const USUARIO = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "399470356836-r0kgrpnv5vutp8fsq263sa4kcafv9b4m.apps.googleusercontent.com";
const SECRET = "GOCSPX-abcdEFGH1234_ijklMNOP5678-qrs";

/** O que o Postgres devolve de verdade quando a cor não passa no CHECK. */
const ERRO_DA_COR = {
  code: "23514",
  message:
    'new row for relation "platform_branding" violates check constraint "platform_branding_accent_hex"',
  details: 'Failing row contains (1, "Webtecnica", null, #FFF).',
  hint: null,
};

/** O que o PostgREST devolve quando o `service_role` perde o grant. */
const ERRO_DE_PERMISSAO = {
  code: "42501",
  message: 'permission denied for table "platform_google_oauth"',
  details: null,
  hint: null,
};

const h = vi.hoisted(() => ({
  erro: null as { code: string; message: string; details?: string | null; hint?: string | null } | null,
  gravacoes: [] as Record<string, unknown>[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({
    ok: true,
    ctx: { user: { id: USUARIO }, platformAdmin: { scope: "full" } },
  }),
}));

/**
 * Um admin client só para as três: `upsert` devolve o erro do teste e o `select`
 * devolve a linha já configurada (o `updateMetaApp` lê antes de gravar).
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async (valores: Record<string, unknown>) => {
        h.gravacoes.push(valores);
        return { error: h.erro };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { app_secret_encrypted: "cifrado", verify_token_encrypted: "cifrado" },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_admin: unknown, valor: string) => `cifra(${valor})`,
}));
vi.mock("@/lib/agenda/google/config", () => ({ invalidarCredencialDoGoogle: () => undefined }));
vi.mock("@/lib/channels/meta/app", () => ({ invalidarAppDaMeta: () => undefined }));
vi.mock("@/lib/branding/instalacao", () => ({ invalidarMarcaDaInstalacao: () => undefined }));

/** O que a tela não pode dizer, em nenhum desfecho. */
const VAZAMENTOS = ["error.message", "constraint", "relation", "violates"];

function semVazamento(resultado: { ok: boolean; error?: string }, erro: typeof h.erro) {
  const serializado = JSON.stringify(resultado);
  for (const proibido of VAZAMENTOS) expect(serializado.toLowerCase()).not.toContain(proibido);
  if (erro) {
    expect(serializado).not.toContain(erro.message);
    expect(serializado).not.toContain("platform_branding");
    expect(serializado).not.toContain("platform_google_oauth");
  }
}

beforeEach(() => {
  h.erro = null;
  h.gravacoes.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("updateBranding — o cru fica no log, a cor tem frase própria", () => {
  const ENTRADA = {
    app_name: "Webtecnica",
    logo_url: null,
    accent_hex: "#1a2b3c",
    accent_dark_hex: null,
    show_powered_by: false,
  };

  it("⭐ recusa da cor: toast com a frase da COR, sem constraint/relation/violates, e com o cru no log", async () => {
    h.erro = ERRO_DA_COR;

    const { updateBranding } = await import("@/app/actions/settings/updateBranding");
    const r = await updateBranding(ENTRADA);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe(
      "A cor da marca precisa ser um hexadecimal de seis dígitos, como #1a2b3c.",
    );
    semVazamento(r, ERRO_DA_COR);

    const log = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("platform_branding_accent_hex");
    expect(log).toContain('"code":"23514"');
  });

  it("erro desconhecido cai na genérica — nunca no texto do servidor", async () => {
    h.erro = { code: "XX000", message: 'relation "platform_branding" is locked' };

    const { updateBranding } = await import("@/app/actions/settings/updateBranding");
    const r = await updateBranding(ENTRADA);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("Não foi possível salvar. Tente de novo.");
    semVazamento(r, h.erro);
  });

  it("o caminho de sucesso continua devolvendo `{ ok: true }`", async () => {
    const { updateBranding } = await import("@/app/actions/settings/updateBranding");
    const r = await updateBranding(ENTRADA);

    expect(r).toEqual({ ok: true });
    expect(h.gravacoes).toHaveLength(1);
  });
});

describe("updateGoogleOAuth — permissão negada não nomeia a tabela no toast", () => {
  it("⭐ 42501 vira a frase de permissão, e o cru vai para o log", async () => {
    h.erro = ERRO_DE_PERMISSAO;

    const { updateGoogleOAuth } = await import("@/app/actions/settings/updateGoogleOAuth");
    const r = await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: SECRET });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("Sua conta não tem permissão para salvar esta configuração.");
    semVazamento(r, ERRO_DE_PERMISSAO);

    const log = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("platform_google_oauth");
  });

  it("o caminho de sucesso continua devolvendo `{ ok: true }`", async () => {
    const { updateGoogleOAuth } = await import("@/app/actions/settings/updateGoogleOAuth");
    const r = await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: SECRET });

    expect(r).toEqual({ ok: true });
  });
});

describe("updateMetaApp — a recusa de banco não vaza o nome da tabela", () => {
  it("⭐ 42501 vira a frase de permissão, e o cru vai para o log", async () => {
    h.erro = {
      code: "42501",
      message: 'permission denied for table "platform_meta_app"',
      details: null,
      hint: null,
    };

    const { updateMetaApp } = await import("@/app/actions/settings/updateMetaApp");
    const r = await updateMetaApp({ app_secret: "0123456789abcdef0123456789abcdef" });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("Sua conta não tem permissão para salvar esta configuração.");
    semVazamento(r, h.erro);
  });
});
