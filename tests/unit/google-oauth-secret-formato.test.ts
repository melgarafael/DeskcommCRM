import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CAMPO DO SECRET NÃO PODE ACEITAR A COLAGEM ERRADA.
 *
 * ─── O defeito que este arquivo prende ───────────────────────────────────────
 *
 * `updateGoogleOAuth` aceitava qualquer `client_secret` de 10–300 chars. O modo
 * de falha medido em produção: colar, no campo da tela, o secret JUNTO com o
 * resto da linha do arquivo JSON de credenciais do Google —
 * `GOCSPX-xxxx","redirect_uris` — que carrega aspa e vírgula. O save gravava os
 * caracteres a mais; o campo é `type="password"` e some ao salvar, então ninguém
 * relia o que ficou. A única pista chegava lá na frente, na troca do código do
 * OAuth, como `invalid_client` do Google — um erro que aponta para o Google e
 * não para a colagem. Foi exatamente o que travou a conexão do Google numa
 * instalação real até o secret ser cortado à mão no banco.
 *
 * A cerca é no CONJUNTO de caracteres (`FORMATO_DO_CLIENT_SECRET`), não no
 * prefixo `GOCSPX-`: secrets antigos não o têm e o Google pode mudar o formato;
 * o que não muda é que aspa, vírgula e espaço nunca pertencem a um secret.
 *
 * ─── Sabotagem que confirma que a guarda vigia ───────────────────────────────
 *
 * Remover `.regex(FORMATO_DO_CLIENT_SECRET, …)` do schema deixa o caso ⭐
 * vermelho: a colagem passa, a action grava e devolve `{ ok: true }`.
 */

const USUARIO = "22222222-2222-4222-8222-222222222222";
const SECRET_LIMPO = "GOCSPX-abcdEFGH1234_ijklMNOP5678-qrs";
const SECRET_COLADO_DO_JSON = 'GOCSPX-abcdEFGH1234_ijklMNOP5678-qrs","redirect_uris';
const CLIENT_ID = "399470356836-r0kgrpnv5vutp8fsq263sa4kcafv9b4m.apps.googleusercontent.com";

const gravacoes: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({ ok: true, ctx: { user: { id: USUARIO } } }),
}));

vi.mock("@/lib/agenda/google/config", () => ({
  invalidarCredencialDoGoogle: () => {},
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "platform_google_oauth") throw new Error(`tabela inesperada: ${tabela}`);
      return {
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

const audit = vi.fn(async (_evento: unknown) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (evento: unknown) => audit(evento) }));

beforeEach(() => {
  gravacoes.length = 0;
  audit.mockClear();
});

async function acao() {
  return (await import("@/app/actions/settings/updateGoogleOAuth")).updateGoogleOAuth;
}

describe("updateGoogleOAuth — formato do client secret", () => {
  it("⭐ recusa o secret colado junto com o JSON, com frase que diz o que fazer, e não grava", async () => {
    const updateGoogleOAuth = await acao();

    const r = await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: SECRET_COLADO_DO_JSON });

    expect(r.ok).toBe(false);
    // A mensagem é para quem não programa: nomeia a ação ("copie só o GOCSPX-"),
    // não um código. Não é o genérico `invalid_input`.
    expect(r.ok === false && r.error).toMatch(/GOCSPX-/);
    expect(r.ok === false && r.error).not.toBe("invalid_input");
    expect(gravacoes, "a colagem com aspa/vírgula não pode chegar ao banco").toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("aceita um secret limpo, grava cifrado e audita o que mudou", async () => {
    const updateGoogleOAuth = await acao();

    const r = await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: SECRET_LIMPO });

    expect(r).toEqual({ ok: true });
    expect(gravacoes).toHaveLength(1);
    expect(gravacoes[0]).toMatchObject({
      id: 1,
      client_id: CLIENT_ID,
      client_secret_encrypted: `cifra(${SECRET_LIMPO})`,
    });
    // A trilha registra O QUE mudou, jamais o valor.
    expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET_LIMPO);
  });

  it("salvar só o client id (sem secret) continua valendo — corrigir o id sem redigitar a chave", async () => {
    const updateGoogleOAuth = await acao();

    const r = await updateGoogleOAuth({ client_id: CLIENT_ID });

    expect(r).toEqual({ ok: true });
    expect(gravacoes[0]).not.toHaveProperty("client_secret_encrypted");
  });
});
