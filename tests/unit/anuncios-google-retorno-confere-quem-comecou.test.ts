/**
 * A volta da conexão de anúncios do Google só é aceita quando vem do mesmo
 * navegador que a começou, sob a mesma régua de sessão de suporte dos outros
 * callbacks, e nunca vira 500 quando o `state` não pode ser conferido.
 *
 * Irmão de `tests/unit/oauth-retorno-vale-uma-vez.test.ts` (uso único). Aqui
 * cada caso mede um portão: sem ele, o caso correspondente reprova.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "um-segredo-de-instalacao-bem-comprido";
const ORG = randomUUID();
const USER = randomUUID();
const SESSAO = randomUUID();
const CALLBACK = "/api/v1/plataformas-de-anuncio/google/callback";

const fake = vi.hoisted(() => ({
  env: {
    INTERNAL_SECRET: "um-segredo-de-instalacao-bem-comprido",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    GOOGLE_ADS_OAUTH_CLIENT_ID: "oauth-id",
    GOOGLE_ADS_OAUTH_CLIENT_SECRET: "oauth-secret-ficticio",
    GOOGLE_ADS_DEVELOPER_TOKEN: "",
  },
  nonces: new Set<string>(),
  trocas: 0,
  suporteLibera: true,
  chamadasDeSuporte: [] as unknown[][],
  erros: [] as string[],
  conferirConta: vi.fn(),
  gravar: vi.fn(),
  revalidarAdmin: vi.fn(),
  papel: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: fake.env }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Central de Teste" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: (msg: string) => fake.erros.push(msg), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  authenticatedSessionId: async () => SESSAO,
  supportCallbackWriteAllowed: async (...args: unknown[]) => {
    fake.chamadasDeSuporte.push(args);
    return fake.suporteLibera;
  },
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: fake.papel,
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "cifrado" }));
vi.mock("@/lib/plataformas-de-anuncio/google/api-google-ads", () => ({
  conferirContaDeRelatorio: fake.conferirConta,
}));
vi.mock("@/lib/plataformas-de-anuncio/google/token", () => ({
  trocarCodigoPorToken: async () => {
    fake.trocas += 1;
    return { ok: true, token: { access_token: "acesso", refresh_token: "r" } };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: fake.revalidarAdmin,
    from: (tabela: string) => ({
      insert: async (linha: { nonce: string }) => {
        if (tabela !== "calendar_oauth_nonces") return { error: null };
        if (fake.nonces.has(linha.nonce)) return { error: { code: "23505", message: "duplicate key" } };
        fake.nonces.add(linha.nonce);
        return { error: null };
      },
      upsert: (linha: unknown, opcoes: unknown) => fake.gravar(tabela, linha, opcoes),
    }),
  }),
}));

beforeEach(() => {
  fake.env.INTERNAL_SECRET = SEGREDO;
  fake.nonces.clear();
  fake.trocas = 0;
  fake.suporteLibera = true;
  fake.chamadasDeSuporte = [];
  fake.erros = [];
  fake.conferirConta.mockReset().mockResolvedValue({ ok: true, dados: {} });
  fake.gravar.mockReset().mockResolvedValue({ error: null });
  fake.revalidarAdmin.mockReset().mockResolvedValue({ error: null, data: true });
  fake.papel.mockReset().mockResolvedValue({ ok: true, user: { id: USER }, org: { orgId: ORG } });
});

/** Começa a conexão como o navegador faria e devolve o `state` e o cookie gravado. */
async function comecar(query = "") {
  const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/connect/route");
  const resposta = await GET(new NextRequest(`http://localhost/api/v1/plataformas-de-anuncio/google/connect${query}`));
  const consentimento = new URL(resposta.headers.get("location")!);
  const state = consentimento.searchParams.get("state")!;
  const gravado = resposta.cookies.get("crm_oauth_bind");
  expect(gravado, "o connect não gravou o cookie de vínculo").toBeDefined();
  expect(gravado!.path).toBe(CALLBACK);
  expect(gravado!.httpOnly).toBe(true);
  expect(gravado!.sameSite).toBe("lax");
  return { state, cookie: `crm_oauth_bind=${gravado!.value}`, consentimento };
}

/**
 * A volta — cujo destino vem do `Location` OU do CORPO da ponte (issue #4335).
 *
 * Este é um retorno de NAVEGADOR vindo de `accounts.google.com`: a cadeia
 * começou em outro site e o cookie de sessão é `sameSite: "strict"`. Um 302
 * daqui para `/app/settings/conversoes` continua a cadeia, o `proxy.ts` não
 * enxerga usuário e a pessoa cai em `/login` com a conexão já gravada — nunca
 * vê a tela de conversões. Por isso a entrega é a ponte: documento same-origin
 * com 200, `location.replace` disparado por nós.
 */
async function voltar(state: string, cookie?: string, parametros = "code=c") {
  const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/callback/route");
  const resposta = await GET(
    new NextRequest(`http://localhost${CALLBACK}?${parametros}&state=${encodeURIComponent(state)}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
  let destino: URL;
  const location = resposta.headers.get("location");
  if (location) {
    destino = new URL(location);
  } else {
    const corpo = await resposta.clone().text();
    const m = /window\.location\.replace\((".*?")\);/.exec(corpo);
    expect(m, "a volta não trouxe nem `Location` nem a ponte").not.toBeNull();
    destino = new URL(JSON.parse(m![1]!) as string, "http://localhost:3000");
  }
  return {
    ok: destino.searchParams.get("ok"),
    erro: destino.searchParams.get("erro"),
    status: resposta.status,
    location: resposta.headers.get("location"),
    destino,
  };
}

describe("a volta da conexão de anúncios confere quem começou", () => {
  it("controle: o mesmo navegador volta e a conexão é gravada", async () => {
    const { state, cookie } = await comecar();
    const volta = await voltar(state, cookie);
    expect(volta.ok).toBe("1");
    expect(volta.erro).toBeNull();
    // Sucesso sai pela PONTE, não por 302: é tela do `/app`, e o 302 continuaria
    // a cadeia cross-site do Google (cookie Strict não viaja) — issue #4335.
    expect(volta.status).toBe(200);
    expect(volta.location).toBeNull();
    expect(fake.trocas).toBe(1);
    expect(fake.gravar.mock.calls[0]?.[0]).toBe("ad_platform_connections");
    expect(fake.papel).toHaveBeenCalledWith("admin", expect.objectContaining({ allowPlatformAdmin: false }));
  });

  it("sem o cookie de quem começou: recusa sem queimar o nonce nem trocar o código", async () => {
    const { state } = await comecar();
    expect((await voltar(state)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
    expect(fake.nonces.size, "a recusa veio depois da queima do nonce").toBe(0);
  });

  it("com o cookie de OUTRO começo: recusa", async () => {
    const primeiro = await comecar();
    const segundo = await comecar();
    expect((await voltar(primeiro.state, segundo.cookie)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
  });

  it("aplica a régua de sessão de suporte com quem e qual sessão começou", async () => {
    const { state, cookie } = await comecar();
    fake.suporteLibera = false;
    expect((await voltar(state, cookie)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
    expect(fake.nonces.size).toBe(0);
    expect(fake.chamadasDeSuporte).toEqual([[ORG, USER, SESSAO]]);
  });

  it("segredo curto: volta para a tela com estado_invalido e registra no log, sem 500", async () => {
    const { state, cookie } = await comecar();
    fake.env.INTERNAL_SECRET = "curto";
    expect((await voltar(state, cookie)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
    expect(fake.erros.some((m) => m.includes("state não verificável"))).toBe(true);
  });
});

const RELATORIO = "?purpose=reporting&customer_id=111-222-3333&login_customer_id=5556667777&label=Unidade%20B";

describe("conectar uma segunda conta de relatórios", () => {
  it("escolhe o login, pede apenas adwords e grava no tenant e anunciante assinados", async () => {
    const { state, cookie, consentimento } = await comecar(RELATORIO);
    expect(consentimento.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(consentimento.searchParams.get("prompt")?.split(" ")).toContain("select_account");
    expect(fake.papel).toHaveBeenCalledWith("admin", expect.objectContaining({ allowPlatformAdmin: true }));
    const { destino } = await voltar(state, cookie, "code=c&customer_id=0000000000&purpose=conversion");
    expect(destino.pathname + destino.search).toBe("/app/ads/google?aba=midia&ok=1&conta=1112223333");
    expect(fake.conferirConta).toHaveBeenCalledWith("acesso", "1112223333", "5556667777");
    expect(fake.revalidarAdmin).toHaveBeenCalledWith("fn_google_ads_admin_do_relatorio", {
      p_org: ORG, p_actor: USER, p_session: SESSAO, p_suporte: null,
    });
    expect(fake.gravar.mock.calls).toEqual([["google_ads_reporting_accounts", {
      organization_id: ORG, customer_id: "1112223333", login_customer_id: "5556667777",
      label: "Unidade B", refresh_token_encrypted: "cifrado",
    }, { onConflict: "organization_id,customer_id" }]]);
    expect((await voltar(state, cookie)).erro).toBe("estado_invalido");
    expect(fake.gravar).toHaveBeenCalledOnce();
  });

  it.each(["sem_permissao", "projeto_sem_acesso"])("preserva a conexão anterior quando a consulta devolve %s", async (falha) => {
    fake.conferirConta.mockResolvedValue({ ok: false, falha, detalhe: "privado" });
    const { state, cookie } = await comecar(RELATORIO);
    expect((await voltar(state, cookie)).destino.search).toBe(`?aba=midia&erro=${falha}`);
    expect(fake.gravar).not.toHaveBeenCalled();
  });

  it("o formulário sem MCC usa o acesso direto e verifica o próprio anunciante", async () => {
    const { state, cookie } = await comecar("?purpose=reporting&label=Unidade+A&customer_id=1112223333&login_customer_id=");
    expect((await voltar(state, cookie)).ok).toBe("1");
    expect(fake.conferirConta).toHaveBeenCalledWith("acesso", "1112223333", null);
  });

  it("perda do papel ou fim do acompanhamento durante o consentimento impede a gravação", async () => {
    const suporte = randomUUID();
    fake.papel.mockResolvedValue({ ok: true, user: { id: USER, support: { id: suporte } }, org: { orgId: ORG } });
    const { state, cookie } = await comecar(RELATORIO);
    fake.revalidarAdmin.mockResolvedValue({ error: null, data: false });
    expect((await voltar(state, cookie)).erro).toBe("estado_invalido");
    expect(fake.revalidarAdmin).toHaveBeenCalledWith("fn_google_ads_admin_do_relatorio", {
      p_org: ORG, p_actor: USER, p_session: SESSAO, p_suporte: suporte,
    });
    expect(fake.gravar).not.toHaveBeenCalled();
  });

  it("cancelar no Google volta ao painel sem tocar em nenhuma conexão", async () => {
    const { state, cookie } = await comecar(RELATORIO);
    expect((await voltar(state, cookie, "error=access_denied")).destino.search).toBe("?aba=midia&erro=cancelado");
    expect(fake.trocas).toBe(0);
    expect(fake.gravar).not.toHaveBeenCalled();
  });

  it("destino inválido não inicia consentimento nem tenta configurar conversões", async () => {
    const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/connect/route");
    const resposta = await GET(new NextRequest(`http://localhost/connect${RELATORIO.replace("111-222-3333", "inválido")}`));
    const destino = new URL(resposta.headers.get("location")!);
    expect(destino.pathname + destino.search).toBe("/app/ads/google?aba=midia&erro=estado_invalido");
    expect(resposta.cookies.get("crm_oauth_bind")).toBeUndefined();
  });
});
