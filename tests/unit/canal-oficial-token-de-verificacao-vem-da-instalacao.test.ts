import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TELA DE CONEXÕES NÃO PODE MANDAR COLAR NA META UM TOKEN QUE NÃO VALE.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 *
 * `GET /api/v1/channels/official` devolvia `process.env.META_WEBHOOK_VERIFY_TOKEN`.
 * Depois da migration 0257 o handshake confere o token do BANCO primeiro
 * (`lib/channels/meta/app.ts`), e a rota ficou errada nos dois sentidos:
 *
 *   - com o App da Meta cadastrado em /admin/meta e um token antigo no `.env`, a
 *     tela mostrava o do `.env` — o dono colava na Meta e recebia 403;
 *   - sem `.env`, a tela dizia "defina no servidor" a quem já tinha configurado
 *     tudo pela tela de administração.
 *
 * ─── O que se prende ─────────────────────────────────────────────────────────
 *
 * O token mostrado aqui é SEMPRE o que vale, ou nenhum. O do banco não é
 * devolvido (foi exibido uma vez, na action que o gerou; quem lê esta rota é o
 * admin de UM tenant), e a tela recebe `verifyTokenOrigem` para dizer onde ele
 * está. O do `.env`, quando é o que vale, continua sendo mostrado como sempre.
 *
 * Sabotagem que confirma a guarda: devolver o token em vigor sem olhar a origem
 * deixa o caso ⭐ vermelho; voltar a ler `process.env` direto deixa os quatro.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SEGREDO_DO_BANCO = "segredo-do-banco-de-teste";
const TOKEN_DO_BANCO = "token-do-banco-que-o-tenant-nao-ve";
const SEGREDO_DO_ENV = "segredo-do-env-de-teste";
const TOKEN_DO_ENV = "token-do-env-de-teste";

let linhaDaMeta: { app_secret_encrypted: string | null; verify_token_encrypted: string | null } | null = null;
let usuario: { id: string; idioma: "pt-BR"; is_platform_admin: boolean; support?: boolean } = {
  id: "u1",
  idioma: "pt-BR",
  is_platform_admin: false,
};

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: usuario, org: { orgId: ORG, role: "admin" } }),
}));

vi.mock("@/lib/supabase/admin", () => {
  const canal = {
    id: "canal-1",
    meta_phone_number_id: "1103328999528818",
    meta_waba_id: "2434045433735175",
    meta_token_encrypted: "\\x_cifra",
    phone_number: "+5511999998888",
    display_name: "Canal oficial",
    webhook_path_token: "tok-do-canal",
    status: "WORKING",
  };
  const cadeiaDoCanal = {
    select: () => cadeiaDoCanal,
    eq: () => cadeiaDoCanal,
    is: () => cadeiaDoCanal,
    maybeSingle: async () => ({ data: canal, error: null }),
  };
  return {
    createAdminClient: () => ({
      from: (tabela: string) =>
        tabela === "platform_meta_app"
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linhaDaMeta, error: null }) }) }) }
          : cadeiaDoCanal,
    }),
  };
});

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(),
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) =>
    ({ cifra_segredo: SEGREDO_DO_BANCO, cifra_token: TOKEN_DO_BANCO })[cifrado] ?? null,
}));

const ORIGINAL = { ...process.env };

beforeEach(async () => {
  linhaDaMeta = null;
  usuario = { id: "u1", idioma: "pt-BR", is_platform_admin: false };
  delete process.env.META_APP_SECRET;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  // O resolvedor memoriza o par por 30s no `globalThis`; cada caso é uma instalação.
  (await import("@/lib/channels/meta/app")).invalidarAppDaMeta();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function webhookDaTela(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/v1/channels/official/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/channels/official"));
  const corpo = (await res.json()) as { data: { webhook: Record<string, unknown> } };
  return corpo.data.webhook;
}

describe("GET /api/v1/channels/official — o token de verificação", () => {
  it("⭐ App cadastrado na instalação: não devolve token nenhum, e diz onde ele está", async () => {
    linhaDaMeta = { app_secret_encrypted: "cifra_segredo", verify_token_encrypted: "cifra_token" };
    // O `.env` antigo continua lá — e NÃO é mais o que a Meta precisa receber.
    process.env.META_APP_SECRET = SEGREDO_DO_ENV;
    process.env.META_WEBHOOK_VERIFY_TOKEN = TOKEN_DO_ENV;

    const webhook = await webhookDaTela();

    expect(webhook.verifyToken).toBeNull();
    expect(webhook.verifyTokenOrigem).toBe("instalacao");
    expect(JSON.stringify(webhook)).not.toContain(TOKEN_DO_BANCO);
    expect(webhook.callbackUrl).toContain("/api/v1/webhooks/meta/tok-do-canal");
  });

  it("só o .env: mostra o token do arquivo, como sempre mostrou", async () => {
    process.env.META_APP_SECRET = SEGREDO_DO_ENV;
    process.env.META_WEBHOOK_VERIFY_TOKEN = TOKEN_DO_ENV;

    const webhook = await webhookDaTela();

    expect(webhook.verifyToken).toBe(TOKEN_DO_ENV);
    expect(webhook.verifyTokenOrigem).toBe("ambiente");
  });

  it("meia credencial no banco cai para o .env — e a tela mostra o do .env, que é o que vale", async () => {
    linhaDaMeta = { app_secret_encrypted: "cifra_segredo", verify_token_encrypted: null };
    process.env.META_APP_SECRET = SEGREDO_DO_ENV;
    process.env.META_WEBHOOK_VERIFY_TOKEN = TOKEN_DO_ENV;

    const webhook = await webhookDaTela();

    expect(webhook.verifyToken).toBe(TOKEN_DO_ENV);
    expect(webhook.verifyTokenOrigem).toBe("ambiente");
  });

  it("nada configurado em lugar nenhum: nem token, nem origem", async () => {
    const webhook = await webhookDaTela();

    expect(webhook.verifyToken).toBeNull();
    expect(webhook.verifyTokenOrigem).toBeNull();
  });
});

describe("GET /api/v1/channels/official — a porta para a tela da instalação", () => {
  it("quem administra a instalação recebe o endereço da tela", async () => {
    usuario = { ...usuario, is_platform_admin: true };

    expect((await webhookDaTela()).configurarEm).toBe("/admin/meta");
  });

  it("o admin de um tenant não recebe um link que daria 404 — nem em modo suporte", async () => {
    expect((await webhookDaTela()).configurarEm).toBeNull();

    usuario = { ...usuario, is_platform_admin: true, support: true };
    expect((await webhookDaTela()).configurarEm).toBeNull();
  });
});
