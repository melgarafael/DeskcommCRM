import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SÓ QUEM ADMINISTRA A INSTALAÇÃO TROCA O APP DA META — provado pela action.
 *
 * ─── O que estava sem vigia ──────────────────────────────────────────────────
 *
 * `updateMetaApp` e `rotacionarVerifyTokenDaMeta` gravam a credencial que assina
 * a entrada de mensagens de TODAS as organizações da VPS. O que as fecha é a
 * primeira linha de cada uma: `requirePlatformAdmin()`. Medido pelo revisor do
 * lote 8: apagando essa chamada das duas, a suíte inteira ficava verde (876
 * arquivos) — o teste vizinho, `app-da-meta-save-exige-o-segredo.test.ts`, DUBLA
 * o `requirePlatformAdmin` para devolver sempre um admin, e por construção não
 * tem como ver a chamada sumir.
 *
 * ─── O que é de verdade e o que é dublê ──────────────────────────────────────
 *
 * O `requirePlatformAdmin` é o de verdade, e o `redirect` também (`next/navigation`
 * lança `NEXT_REDIRECT` fora do runtime do Next). Dublados são só a SESSÃO — o
 * client de `@/lib/supabase/server`, com ou sem linha em `platform_admins` — e o
 * client de service role, que CONTA cada `from()`. A contagem é a prova: a recusa
 * tem de acontecer antes de a action encostar no banco da instalação, não depois
 * de ler o que está gravado.
 *
 * Os controles (com a linha) existem para a recusa não poder vir de um dublê
 * quebrado: sem eles, "lançou" seria verde também se a sessão nunca respondesse.
 *
 * Sabotagem que confirma a vigia: apagar `await requirePlatformAdmin()` de uma das
 * duas actions deixa vermelho o caso dela.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const SEGREDO = "0123456789abcdef0123456789abcdef";

/** A linha de `platform_admins` que a sessão enxerga — `null` é "não é admin da instalação". */
let linhaDeAdmin: Record<string, unknown> | null = null;
const tabelasDaSessao: string[] = [];
const tabelasDoServiceRole: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USUARIO } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" }, error: null }),
      },
    },
    from: (tabela: string) => {
      tabelasDaSessao.push(tabela);
      if (tabela !== "platform_admins") throw new Error(`[dublê] a sessão não lê ${tabela}`);
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        is: () => cadeia,
        maybeSingle: async () => ({ data: linhaDeAdmin, error: null }),
      };
      return cadeia;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      tabelasDoServiceRole.push(tabela);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { app_secret_encrypted: "cifra(antiga)", verify_token_encrypted: "cifra(token-antigo)" },
              error: null,
            }),
          }),
        }),
        upsert: async () => ({ error: null }),
      };
    },
  }),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_admin: unknown, valor: string) => `cifra(${valor})`,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

beforeEach(() => {
  linhaDeAdmin = null;
  tabelasDaSessao.length = 0;
  tabelasDoServiceRole.length = 0;
});

async function acoes() {
  return import("@/app/actions/settings/updateMetaApp");
}

/** O `redirect` real lança um erro cujo `digest` carrega o destino. */
function destinoDoRedirect(erro: unknown): string | null {
  const digest = (erro as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  return digest.split(";")[2] ?? null;
}

async function recusa(chamada: () => Promise<unknown>): Promise<string | null> {
  try {
    await chamada();
  } catch (erro) {
    return destinoDoRedirect(erro);
  }
  return "(a action terminou sem redirecionar)";
}

const ADMIN_DA_INSTALACAO = {
  user_id: USUARIO,
  scope: "full",
  mfa_required: false,
  revoked_at: null,
};

describe("updateMetaApp — o gate da instalação", () => {
  it("⭐ sessão SEM linha em platform_admins é mandada para /admin/forbidden antes de tocar o banco", async () => {
    const { updateMetaApp } = await acoes();

    expect(await recusa(() => updateMetaApp({ app_secret: SEGREDO }))).toBe("/admin/forbidden");
    // Controle do próprio dublê: a sessão FOI consultada. Sem isto, um redirect
    // vindo de outro lugar passaria por esta recusa.
    expect(tabelasDaSessao).toEqual(["platform_admins"]);
    expect(tabelasDoServiceRole, "a action leu ou gravou o app da Meta para quem não administra a instalação").toEqual([]);
  });

  it("CONTROLE: com a linha em platform_admins, a mesma chamada chega ao banco da instalação", async () => {
    linhaDeAdmin = ADMIN_DA_INSTALACAO;
    const { updateMetaApp } = await acoes();

    expect(await updateMetaApp({ app_secret: SEGREDO })).toEqual({ ok: true });
    expect(tabelasDoServiceRole).toContain("platform_meta_app");
  });
});

describe("rotacionarVerifyTokenDaMeta — o gate da instalação", () => {
  it("⭐ sessão SEM linha em platform_admins é mandada para /admin/forbidden antes de tocar o banco", async () => {
    const { rotacionarVerifyTokenDaMeta } = await acoes();

    expect(await recusa(() => rotacionarVerifyTokenDaMeta())).toBe("/admin/forbidden");
    expect(tabelasDaSessao).toEqual(["platform_admins"]);
    expect(tabelasDoServiceRole, "a rotação gerou token para quem não administra a instalação").toEqual([]);
  });

  it("CONTROLE: com a linha em platform_admins, a rotação chega ao banco da instalação", async () => {
    linhaDeAdmin = ADMIN_DA_INSTALACAO;
    const { rotacionarVerifyTokenDaMeta } = await acoes();

    const r = await rotacionarVerifyTokenDaMeta();
    expect(r.ok).toBe(true);
    expect(tabelasDoServiceRole).toContain("platform_meta_app");
  });
});
