/**
 * O cache curto da autorização (#3696) NA CADEIA DE VERDADE — `loadAuthUser` e
 * `requireRole`, com o Supabase dublado.
 *
 * O caso que impede o desastre é o terceiro: **revogou → a próxima requisição
 * nega**. Os outros três fixam o que o cache compra e o que ele não pode custar:
 * duas requisições na janela leem o vínculo uma vez; passado o TTL, relê; e
 * erro de banco continua estourando (não é estado, não vira resposta de 30 s).
 *
 * O último bloco é uma CERCA: percorre os arquivos que escrevem vínculo, papel
 * ou estado de organização e reprova quem esquecer de invalidar. Uma invalidação
 * que depende de alguém lembrar, num caminho NOVO, é a mesma coisa que não ter
 * invalidação — e é o defeito que este cache pode introduzir no produto.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const relogio = { agora: Date.UTC(2026, 9, 29, 12, 0, 0) };
const EXPIRACAO_DO_TOKEN_S = Math.floor(relogio.agora / 1000) + 3600;

/** O jar de cookies da requisição — trocado por caso, como o navegador faria. */
let cookieStore: { name: string; value: string }[] = [];

const estado = {
  membros: [] as { organization_id: string; role: string; organizations: unknown }[],
  erroDeVinculo: null as null | { code: string; message: string },
  platformAdmin: null as null | { user_id: string; scope: string },
  papel: null as string | null,
  leiturasDeVinculo: 0,
  getUsers: 0,
  suporte: null as unknown,
  leiturasDeSuporte: 0,
};

function cookieDeSessao(): { name: string; value: string } {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = `${b64({ alg: "HS256" })}.${b64({ sub: USER_ID, exp: EXPIRACAO_DO_TOKEN_S })}.assinatura`;
  return {
    name: "sb-deskcomm-auth",
    value: `base64-${b64({ access_token: token, expires_at: EXPIRACAO_DO_TOKEN_S })}`,
  };
}

function cadeia(resultado: () => unknown) {
  const elo = {
    select: () => elo,
    eq: () => elo,
    is: () => elo,
    order: () => elo,
    not: () => elo,
    maybeSingle: async () => resultado(),
    then: (resolver: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolver),
  };
  return elo;
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nome: string) => cookieStore.find((c) => c.name === nome),
    getAll: () => cookieStore,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => cadeia(() => ({ data: null, error: null })),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        estado.getUsers += 1;
        return {
          data: { user: { id: USER_ID, email: "membro@example.com", user_metadata: {} } },
          error: null,
        };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }),
      },
    },
    from: (tabela: string) => {
      if (tabela === "user_organizations") {
        estado.leiturasDeVinculo += 1;
        return cadeia(() => ({ data: estado.membros, error: estado.erroDeVinculo }));
      }
      if (tabela === "platform_admins") {
        return cadeia(() => ({ data: estado.platformAdmin, error: null }));
      }
      return cadeia(() => ({ data: null, error: null }));
    },
    rpc: async (fn: string) => {
      if (fn === "fn_user_role_in_org") return { data: estado.papel, error: null };
      // Contexto de acompanhamento e prova de MFA: nada em curso, salvo o caso
      // que semeia `estado.suporte`.
      if (fn === "fn_support_context") {
        estado.leiturasDeSuporte += 1;
        return { data: estado.suporte, error: null };
      }
      return { data: true, error: null };
    },
  }),
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const { esquecerTudo, invalidarUsuario } = await import("@/lib/auth/cache-curto");
const { loadAuthUser } = await import("@/lib/auth/server");
const { requireRole } = await import("@/lib/auth/require-role");

beforeEach(() => {
  esquecerTudo();
  relogio.agora = Date.UTC(2026, 9, 29, 12, 0, 0);
  vi.spyOn(Date, "now").mockImplementation(() => relogio.agora);
  cookieStore = [cookieDeSessao()];
  estado.membros = [
    { organization_id: ORG_ID, role: "admin", organizations: { display_name: "Acme", status: "active" } },
  ];
  estado.erroDeVinculo = null;
  estado.platformAdmin = null;
  estado.papel = "admin";
  estado.leiturasDeVinculo = 0;
  estado.getUsers = 0;
  estado.suporte = null;
  estado.leiturasDeSuporte = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  esquecerTudo();
});

describe("cache curto entre requisições (#3696)", () => {
  it("duas requisições na janela leem o vínculo UMA vez", async () => {
    await loadAuthUser();
    await loadAuthUser();
    expect(estado.leiturasDeVinculo).toBe(1);
  });

  it("passado o TTL de 30 s, volta a ler — o cache vence sozinho", async () => {
    await loadAuthUser();
    relogio.agora += 31_000;
    await loadAuthUser();
    expect(estado.leiturasDeVinculo).toBe(2);
  });

  it("o cache de sessão também poupa o `/auth/v1/user` da segunda requisição", async () => {
    await loadAuthUser();
    await loadAuthUser();
    expect(estado.getUsers).toBe(1);
  });

  it("sem cookie de sessão reconhecível o `getUser` não é reaproveitado", async () => {
    // O cache de SESSÃO precisa da identidade da sessão; sem ela, cada
    // requisição valida o token de novo, como antes do #3696. O snapshot de
    // PERMISSÕES é chaveado pelo usuário (que só existe depois do `getUser`) e
    // segue valendo — é o que sobra de ganho nesse caminho.
    cookieStore = [{ name: "active_org", value: ORG_ID }];
    await loadAuthUser();
    await loadAuthUser();
    expect(estado.getUsers).toBe(2);
    expect(estado.leiturasDeVinculo).toBe(1);
  });

  it("erro de banco NÃO é cacheado: estoura agora e a próxima requisição tenta de novo", async () => {
    estado.erroDeVinculo = { code: "PGRST002", message: "name resolution failed" };
    await expect(loadAuthUser()).rejects.toThrow(/auth_permissions_unavailable/);

    estado.erroDeVinculo = null;
    const depois = await loadAuthUser();
    expect(depois?.organizations).toHaveLength(1);
    expect(estado.leiturasDeVinculo).toBe(2);
  });
});

describe("REVOGAÇÃO — a próxima requisição tem de NEGAR", () => {
  it("revogar o vínculo + invalidar derruba o acesso na hora (não em 30 s)", async () => {
    // 1. Uma requisição autorizada enche o cache.
    const antes = await requireRole("admin");
    expect(antes.ok).toBe(true);

    // 2. A revogação: o banco deixa de ter vínculo. É o que
    //    `app/api/v1/team/[user_id]/revoke/route.ts` faz, na mesma requisição.
    estado.membros = [];
    estado.papel = null;
    invalidarUsuario(USER_ID);

    // 3. Próxima requisição: negada, sem esperar o TTL.
    const depois = await requireRole("admin");
    expect(depois.ok).toBe(false);
    if (depois.ok) throw new Error("unreachable");
    expect(depois.response.status).toBe(403);
    const corpo = await depois.response.json();
    expect(corpo.error.code).toBe("forbidden_tenant");
  });

  it("trocar o papel também vale na hora — promoção e rebaixamento", async () => {
    expect((await requireRole("admin")).ok).toBe(true);

    estado.papel = "agent";
    invalidarUsuario(USER_ID);

    const rebaixado = await requireRole("admin");
    expect(rebaixado.ok).toBe(false);
    if (rebaixado.ok) throw new Error("unreachable");
    expect((await rebaixado.response.json()).error.code).toBe("forbidden_role");
  });

  it("o preço declarado: SEM a invalidação, a janela do TTL autoriza", async () => {
    // Este caso existe para que ninguém se engane sobre o que a invalidação
    // compra. Ele mede o defeito que o cache PODE introduzir e que a
    // invalidação fecha: o vínculo já caiu no banco, o snapshot em cache ainda
    // diz que existe.
    expect((await requireRole("admin")).ok).toBe(true);
    estado.membros = [];

    // Snapshot velho: `orgAtivaSemPortao` responde pela membership em cache.
    expect((await requireRole("admin")).ok).toBe(true);

    // A invalidação é o que transforma isso em negação imediata.
    invalidarUsuario(USER_ID);
    expect((await requireRole("admin")).ok).toBe(false);

    // E, se ela faltar, o TTL ainda fecha a janela.
    esquecerTudo();
    expect((await requireRole("admin")).ok).toBe(false);
  });
});

describe("a identidade alcança as OUTRAS sessões e o acompanhamento ativo não é guardado", () => {
  it("invalidarUsuario derruba o getUser em cache de uma sessão cujo cookie a requisição não tem", async () => {
    const outraSessao = { ...cookieDeSessao(), value: `${cookieDeSessao().value}x` };
    cookieStore = [outraSessao];
    await loadAuthUser();
    await loadAuthUser();
    expect(estado.getUsers).toBe(1);

    // Sair de todos os aparelhos roda na sessão que clicou, com OUTRO cookie.
    cookieStore = [cookieDeSessao()];
    invalidarUsuario(USER_ID);

    cookieStore = [outraSessao];
    await loadAuthUser();
    expect(estado.getUsers).toBe(2);
  });

  it("acompanhamento ATIVO é relido a cada requisição (vence pelo relógio, sem invalidação)", async () => {
    estado.suporte = {
      id: "33333333-3333-4333-8333-333333333333",
      organization_id: ORG_ID,
      actor_user_id: USER_ID,
      auth_session_id: "44444444-4444-4444-8444-444444444444",
      previous_organization_id: null,
      expires_at: new Date(relogio.agora + 60_000).toISOString(),
      name: "Acme",
      locale: null,
      access_mode: "full",
      status: "active",
    };
    expect((await loadAuthUser())?.support?.status).toBe("active");
    estado.suporte = { ...(estado.suporte as object), status: "expired" };
    expect((await loadAuthUser())?.support?.status).toBe("expired");
    expect(estado.leiturasDeSuporte).toBe(2);
  });

  it("controle: a AUSÊNCIA de acompanhamento continua no cache", async () => {
    await loadAuthUser();
    await loadAuthUser();
    expect(estado.leiturasDeSuporte).toBe(1);
  });
});

describe("CERCA — quem escreve vínculo, papel ou estado de org invalida", () => {
  const RAIZ = path.resolve(__dirname, "../..");

  /** Arquivos que a revisão precisa conferir sempre que um caminho novo nascer. */
  const ESCRITAS_DE_AUTORIZACAO = [
    "app/api/v1/team/[user_id]/revoke/route.ts",
    "app/api/v1/team/[user_id]/reactivate/route.ts",
    "app/api/v1/team/[user_id]/_shared.ts",
    "app/api/v1/team/[user_id]/interface/route.ts",
    "app/api/v1/admin/tenants/[id]/suspend/route.ts",
    "app/api/v1/admin/tenants/[id]/reactivate/route.ts",
    "app/api/v1/admin/tenants/[id]/impersonate/route.ts",
    "app/api/v1/admin/impersonate/end/route.ts",
    "app/actions/auth/signOut.ts",
    "app/actions/settings/signOutEverywhere.ts",
    "lib/auth/aplicar-convite.ts",
    "lib/auth/provision.ts",
    // Colunas da empresa que viajam no snapshot (nome, idioma, fuso, moeda, país).
    "lib/tenants/dados-cadastrais.ts",
    "app/actions/onboarding/_shared.ts",
    // Metadata da pessoa (idioma, nome, e-mail) — o `getUser` também está no cache.
    "app/actions/settings/trocarIdioma.ts",
    "app/actions/settings/updateProfile.ts",
    "app/api/v1/admin/tenants/[id]/members/[userId]/email/route.ts",
    // Entradas: o vínculo gravado FORA do app (seed, worker, SQL) não invalida
    // ninguém, e entrar de novo tem de mostrar o estado atual na hora.
    "app/actions/auth/signInWithPassword.ts",
    "app/auth/callback/route.ts",
    "app/auth/confirm/route.ts",
  ];

  it.each(ESCRITAS_DE_AUTORIZACAO)("%s invalida o cache curto", (relativo) => {
    const fonte = readFileSync(path.join(RAIZ, relativo), "utf8");
    expect(fonte).toMatch(/@\/lib\/auth\/cache-curto/);
    expect(fonte).toMatch(/invalidar(Usuario|Org|Sessao)\(/);
  });

  it("nenhum outro arquivo escreve em user_organizations sem invalidar", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const problematicos: string[] = [];

    /**
     * O que conta como ESCRITA: o primeiro método depois do
     * `.from("user_organizations")` ser um verbo de mutação. Apertar assim é o
     * que evita falso positivo — vários arquivos leem `user_organizations` e
     * escrevem em outra tabela logo abaixo (participantes de conversa, token de
     * MCP, dono de agenda), e uma janela de linhas solta reprovaria todos eles.
     */
    const ESCRITA = /^\.(update|insert|upsert|delete)\(/;

    const percorrer = (dir: string) => {
      for (const entrada of readdirSync(dir)) {
        const caminho = path.join(dir, entrada);
        if (statSync(caminho).isDirectory()) {
          percorrer(caminho);
          continue;
        }
        if (!entrada.endsWith(".ts") || entrada.includes(".test.")) continue;
        const fonte = readFileSync(caminho, "utf8");
        const escreveVinculo = [...fonte.matchAll(/\.from\("user_organizations"\)/g)].some((m) =>
          ESCRITA.test(fonte.slice((m.index ?? 0) + m[0].length).trimStart()),
        );
        if (!escreveVinculo) continue;
        if (!fonte.includes("@/lib/auth/cache-curto")) {
          problematicos.push(path.relative(RAIZ, caminho));
        }
      }
    };

    percorrer(path.join(RAIZ, "app"));
    percorrer(path.join(RAIZ, "lib"));

    // Caminho novo de vínculo entra aqui: o cache dele precisa cair junto com a
    // escrita, senão a revogação vira "até 30 s".
    expect(problematicos).toEqual([]);
  });

  it("quem grava o metadata da pessoa (updateUser) invalida o usuário", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    // O `getUser` vai para o cache curto chaveado pelo cookie: a sessão que grava
    // ganha cookie novo, as OUTRAS sessões da pessoa não — sem a invalidação, o
    // idioma e o nome trocados ficam até 30 s velhos nelas.
    const ESCREVE_METADATA = /\.updateUser(ById)?\(/;
    // Senha não está no snapshot (nem no `user_metadata`).
    const FORA = new Set(["app/actions/auth/updatePassword.ts"]);
    const vistos: string[] = [];
    const problematicos: string[] = [];
    const percorrer = (dir: string) => {
      for (const entrada of readdirSync(dir)) {
        const caminho = path.join(dir, entrada);
        if (statSync(caminho).isDirectory()) {
          percorrer(caminho);
          continue;
        }
        if (!/\.tsx?$/.test(entrada) || entrada.includes(".test.")) continue;
        const fonte = readFileSync(caminho, "utf8");
        if (!ESCREVE_METADATA.test(fonte)) continue;
        const relativo = path.relative(RAIZ, caminho);
        vistos.push(relativo);
        if (FORA.has(relativo)) continue;
        if (!fonte.includes("@/lib/auth/cache-curto") || !/invalidarUsuario\(/.test(fonte)) {
          problematicos.push(relativo);
        }
      }
    };
    percorrer(path.join(RAIZ, "app"));
    percorrer(path.join(RAIZ, "lib"));

    // Controle: a sonda enxerga quem troca o idioma (senão o vazio não prova nada).
    expect(vistos).toEqual(expect.arrayContaining(["app/actions/settings/trocarIdioma.ts"]));
    expect(problematicos).toEqual([]);
  });

  it("quem suspende ou reativa a empresa por RPC invalida a org (cobrança inclusive)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    // O `org_status` do snapshot é o que o requireRole e a tela de suspensa
    // leem. A cobrança suspende e reativa pelas mesmas funções do admin; sem
    // `invalidarOrg`, quem pagou fica até 30 s preso na tela de suspensa.
    // Esta cerca prova que a chamada EXISTE, não que alcança o app: pelo
    // webhook do provedor a régua roda no worker, e lá o teto é o TTL.
    const MUDA_ESTADO_DA_ORG = /\.rpc\(\s*"fn_(reativar_organizacao|suspender_organizacao|cobranca_suspender_se_devendo)"/;
    const vistos: string[] = [];
    const problematicos: string[] = [];
    const percorrer = (dir: string) => {
      for (const entrada of readdirSync(dir)) {
        const caminho = path.join(dir, entrada);
        if (statSync(caminho).isDirectory()) {
          percorrer(caminho);
          continue;
        }
        if (!entrada.endsWith(".ts") || entrada.includes(".test.")) continue;
        const fonte = readFileSync(caminho, "utf8");
        if (!MUDA_ESTADO_DA_ORG.test(fonte)) continue;
        vistos.push(path.relative(RAIZ, caminho));
        if (!fonte.includes("@/lib/auth/cache-curto") || !/invalidarOrg\(/.test(fonte)) {
          problematicos.push(path.relative(RAIZ, caminho));
        }
      }
    };
    percorrer(path.join(RAIZ, "app"));
    percorrer(path.join(RAIZ, "lib"));

    // Controle: a sonda enxerga os quatro caminhos conhecidos (senão o vazio
    // abaixo não prova nada).
    expect(vistos).toEqual(
      expect.arrayContaining([
        "app/api/v1/admin/tenants/[id]/reactivate/route.ts",
        "app/api/v1/admin/tenants/[id]/suspend/route.ts",
        "lib/cobranca/dono.ts",
        "lib/cobranca/sincronizar.ts",
      ]),
    );
    expect(problematicos).toEqual([]);
  });
});
