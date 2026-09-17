import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O TOKEN QUE A TELA MOSTRA TEM DE SER O QUE VALE.
 *
 * ─── O defeito que este arquivo prende ───────────────────────────────────────
 *
 * `updateMetaApp` aceitava o PRIMEIRO save sem a chave secreta: o schema a
 * declara opcional (para salvar de novo sem redigitar), e a action só olhava se
 * já havia verify token. Numa instalação vazia isso gravava um token SOZINHO e o
 * devolvia para copiar.
 *
 * Só que o resolvedor (`lib/channels/meta/app.ts`) serve o par INTEIRO ou nada:
 * com meia credencial no banco ele cai para o `.env`. O dono copiava o token,
 * colava no painel da Meta, e o "Verificar e salvar" de lá recebia 403 — o token
 * exibido nunca esteve em vigor, e a tela não tinha como dizer isso. A rotação
 * tinha a mesma fresta: sem chave gravada, ela também produz um token que não
 * vale.
 *
 * ─── O que NÃO mudou, e está preso aqui junto ────────────────────────────────
 *
 * - O token em claro sai UMA vez: na criação e na rotação. O save seguinte, que
 *   só troca a chave, não o devolve.
 * - A trilha de auditoria registra O QUE mudou, jamais o valor.
 *
 * - Leitura que FALHOU não é "nada gravado": sem saber se já existe token, a
 *   action recusa com `leitura_do_app_falhou` e não grava. Antes, a falha lia
 *   como instalação vazia, e salvar uma chave nova regravava um token por cima do
 *   que já estava colado no painel da Meta.
 *
 * Sabotagem que confirma que a guarda vigia: remover a checagem de
 * `app_secret_obrigatorio` em `updateMetaApp` deixa o caso ⭐ vermelho; ignorar o
 * `error` em `oQueEstaGravado` deixa vermelhos os dois casos 🔒.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const SEGREDO = "0123456789abcdef0123456789abcdef";

let linha: { app_secret_encrypted: string | null; verify_token_encrypted: string | null } | null = null;
/** Quando preenchido, a leitura de `platform_meta_app` falha como o PostgREST falha: `data` nulo e `error`. */
let erroDeLeitura: { code: string; message: string } | null = null;
const gravacoes: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: async () => ({ user: { id: USUARIO } }),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "platform_meta_app") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => (erroDeLeitura ? { data: null, error: erroDeLeitura } : { data: linha, error: null }),
          }),
        }),
        upsert: async (valores: Record<string, unknown>) => {
          gravacoes.push(valores);
          return { error: null };
        },
      };
    },
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_admin: unknown, valor: string) => `cifra(${valor})`,
}));

const audit = vi.fn(async (_evento: { metadata?: Record<string, unknown> }) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (evento: { metadata?: Record<string, unknown> }) => audit(evento) }));

beforeEach(() => {
  linha = null;
  erroDeLeitura = null;
  gravacoes.length = 0;
  audit.mockClear();
});

async function acoes() {
  return import("@/app/actions/settings/updateMetaApp");
}

describe("updateMetaApp — o primeiro save", () => {
  it("⭐ sem a chave secreta é recusado, e nada é gravado nem devolvido", async () => {
    const { updateMetaApp } = await acoes();

    const r = await updateMetaApp({});

    expect(r).toEqual({ ok: false, error: "app_secret_obrigatorio" });
    // O ponto do defeito: um token gravado sozinho seria mostrado para copiar
    // sem nunca ter valido.
    expect(gravacoes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("com a chave, grava os dois cifrados e devolve o token uma vez", async () => {
    const { updateMetaApp } = await acoes();

    const r = await updateMetaApp({ app_secret: SEGREDO });

    expect(r.ok).toBe(true);
    const token = r.ok ? r.verifyToken : undefined;
    // 32 bytes em base64url: 43 caracteres, sem `+`, `/` nem `=`, que viraria
    // `%2B`/`%2F` numa cópia manual para a query string do handshake.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gravacoes).toHaveLength(1);
    expect(gravacoes[0]).toMatchObject({
      id: 1,
      app_secret_encrypted: `cifra(${SEGREDO})`,
      verify_token_encrypted: `cifra(${token})`,
    });

    const trilha = JSON.stringify(audit.mock.calls);
    expect(trilha).not.toContain(SEGREDO);
    expect(trilha).not.toContain(token);
  });
});

describe("updateMetaApp — com o app já configurado", () => {
  beforeEach(() => {
    linha = { app_secret_encrypted: "cifra(antiga)", verify_token_encrypted: "cifra(token-antigo)" };
  });

  it("trocar a chave NÃO devolve o token de novo, nem o regrava", async () => {
    const { updateMetaApp } = await acoes();

    const r = await updateMetaApp({ app_secret: SEGREDO });

    expect(r).toEqual({ ok: true });
    expect(gravacoes[0]).not.toHaveProperty("verify_token_encrypted");
  });

  it("salvar sem digitar nada não grava uma trilha de alteração que não houve", async () => {
    const { updateMetaApp } = await acoes();

    expect(await updateMetaApp({})).toEqual({ ok: false, error: "nada_para_salvar" });
    expect(gravacoes).toEqual([]);
  });

  it("chave gravada sem token (linha remendada à mão) completa o par sem pedir a chave de novo", async () => {
    linha = { app_secret_encrypted: "cifra(antiga)", verify_token_encrypted: null };
    const { updateMetaApp } = await acoes();

    const r = await updateMetaApp({});

    expect(r.ok && r.verifyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("rotacionarVerifyTokenDaMeta", () => {
  it("⭐ sem chave gravada é recusada — o token novo não valeria", async () => {
    linha = { app_secret_encrypted: null, verify_token_encrypted: "cifra(token-antigo)" };
    const { rotacionarVerifyTokenDaMeta } = await acoes();

    expect(await rotacionarVerifyTokenDaMeta()).toEqual({ ok: false, error: "app_secret_obrigatorio" });
    expect(gravacoes).toEqual([]);
  });

  it("com o app configurado, devolve um token NOVO e a trilha não carrega o valor", async () => {
    linha = { app_secret_encrypted: "cifra(antiga)", verify_token_encrypted: "cifra(token-antigo)" };
    const { rotacionarVerifyTokenDaMeta } = await acoes();

    const r = await rotacionarVerifyTokenDaMeta();

    const token = r.ok ? r.verifyToken : undefined;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gravacoes[0]).toMatchObject({ verify_token_encrypted: `cifra(${token})` });
    expect(gravacoes[0]).not.toHaveProperty("app_secret_encrypted");
    expect(JSON.stringify(audit.mock.calls)).not.toContain(token);
  });
});

describe("a leitura do que está gravado falhou", () => {
  const FALHA = { code: "57014", message: "canceling statement due to statement timeout" };

  it("🔒 salvar uma chave nova é RECUSADO — não gera token por cima do que já está no painel da Meta", async () => {
    erroDeLeitura = FALHA;
    const { updateMetaApp } = await acoes();

    const r = await updateMetaApp({ app_secret: SEGREDO });

    expect(r).toMatchObject({ ok: false, error: "leitura_do_app_falhou" });
    expect(gravacoes, "a falha de leitura virou 'nunca configurado' e a action gravou mesmo assim").toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("🔒 a rotação é RECUSADA com o motivo certo — não manda cadastrar a chave a quem já cadastrou", async () => {
    erroDeLeitura = FALHA;
    const { rotacionarVerifyTokenDaMeta } = await acoes();

    expect(await rotacionarVerifyTokenDaMeta()).toMatchObject({ ok: false, error: "leitura_do_app_falhou" });
    expect(gravacoes).toEqual([]);
  });
});
