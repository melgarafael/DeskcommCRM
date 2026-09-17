import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ROTA DO WEBHOOK LÊ A CREDENCIAL DO BANCO — E O `.env` CONTINUA SENDO O PISO.
 *
 * ─── O que a issue #850 mediu, na ordem em que aparece ───────────────────────
 *
 * 1. `GET .../meta/<token>` só olhava `META_WEBHOOK_VERIFY_TOKEN`: numa
 *    instalação que não a tem no `.env` o botão "Verificar e salvar" do painel
 *    da Meta nunca conclui, e a tela do CRM não diz o que fazer.
 * 2. `POST` só olhava `META_APP_SECRET`: com a verificação passando, TODA
 *    mensagem recebida morria em `401 invalid_signature` — o número enviava e
 *    não recebia, sem erro em lugar nenhum.
 *
 * ─── Por que um teste de ROTA, se a resolução tem arquivo próprio ────────────
 * `app-da-meta-credencial-do-banco.test.ts` prova a precedência e a
 * não-mistura. Ele NÃO prova que a rota pergunta para o resolvedor: passar a
 * segredo do `.env` direto para o HMAC continuaria verde ali. Aqui o que se
 * mede é o desfecho que a Meta enxerga — status e corpo — com a credencial
 * disponível nas DUAS fontes possíveis.
 */

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "2434045433735175" };
const SEGREDO_DO_BANCO = "segredo-do-banco-de-teste";
const TOKEN_DO_BANCO = "token-do-banco-de-teste";
const SEGREDO_DO_ENV = "segredo-do-env-de-teste";
const TOKEN_DO_ENV = "token-do-env-de-teste";
const CHALLENGE = "desafio-do-handshake";
const ingeridos: unknown[] = [];

/** O que o dublê do banco devolve na leitura da credencial. */
let linhaDoBanco: { app_secret_encrypted: string | null; verify_token_encrypted: string | null } | null = null;
let erroDaLeitura: { code: string; message: string } | null = null;

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));

vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaInbound: async (_a: unknown, e: unknown) => {
    ingeridos.push(e);
    return { status: "ingested" };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "platform_meta_app") {
        // A rota também escreve status de mensagem/modelo depois de ingerir;
        // este arquivo só exercita o caminho de entrada.
        return { update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({}) }) }) }) }) };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: linhaDoBanco, error: erroDaLeitura }) }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) => decifrado[cifrado] ?? null,
}));

let decifrado: Record<string, string | null> = {};

const LINHA_CHEIA = {
  app_secret_encrypted: "\\xSEGREDO_CIFRADO",
  verify_token_encrypted: "\\xTOKEN_CIFRADO",
};

import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { GET, POST } from "@/app/api/v1/webhooks/meta/[token]/route";

const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

/** O GET do handshake, como a Meta o faz. */
function handshake(verifyToken: string) {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": verifyToken,
    "hub.challenge": CHALLENGE,
  });
  return { nextUrl: { searchParams: params } } as never;
}

/** Um POST bem assinado com o segredo informado — é o que a Meta entrega. */
function entrega(segredo: string) {
  const cru = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: SESSAO.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123" },
              messages: [{ id: "wamid.1", from: "5511999999999", type: "text", text: { body: "oi" } }],
            },
          },
        ],
      },
    ],
  });
  return {
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", segredo).update(cru, "utf8").digest("hex")}`,
    }),
  } as never;
}

beforeEach(() => {
  linhaDoBanco = null;
  erroDaLeitura = null;
  decifrado = {};
  ingeridos.length = 0;
  invalidarAppDaMeta();
  vi.stubEnv("META_APP_SECRET", "");
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidarAppDaMeta();
});

describe("o handshake (GET) aceita o verify token do BANCO", () => {
  it("token do banco: 200 com o desafio em texto puro", async () => {
    // Sem isto, a tela do CRM não tem como dizer o que colar no painel da Meta:
    // o operador trava no "Verificar e salvar" e não sabe por quê.
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": SEGREDO_DO_BANCO, "\\xTOKEN_CIFRADO": TOKEN_DO_BANCO };

    const res = await GET(handshake(TOKEN_DO_BANCO), ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CHALLENGE);
  });

  it("token que não é o do banco: 403, e nada é devolvido", async () => {
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": SEGREDO_DO_BANCO, "\\xTOKEN_CIFRADO": TOKEN_DO_BANCO };

    const res = await GET(handshake("token-de-outro-app"), ctx);

    expect(res.status).toBe(403);
  });
});

describe("a entrega (POST) confere o HMAC com o App Secret do BANCO", () => {
  it("assinatura feita com o segredo do banco: 200 e a mensagem é ingerida", async () => {
    // O defeito caro da issue: com a verificação passando e o segredo errado,
    // o número envia e NÃO recebe — 401 em toda entrega, sem sintoma na tela.
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": SEGREDO_DO_BANCO, "\\xTOKEN_CIFRADO": TOKEN_DO_BANCO };

    const res = await POST(entrega(SEGREDO_DO_BANCO), ctx);

    expect(res.status).toBe(200);
    expect(ingeridos).toHaveLength(1);
  });

  it("assinatura feita com o segredo do .env NÃO passa quando o banco tem o dele", async () => {
    // O outro lado da mesma moeda: se o banco tem credencial, é ela que vale —
    // aceitar as duas transformaria a precedência em "qualquer uma serve".
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": SEGREDO_DO_BANCO, "\\xTOKEN_CIFRADO": TOKEN_DO_BANCO };
    vi.stubEnv("META_APP_SECRET", SEGREDO_DO_ENV);
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", TOKEN_DO_ENV);

    const res = await POST(entrega(SEGREDO_DO_ENV), ctx);

    expect(res.status).toBe(401);
    expect(ingeridos).toHaveLength(0);
  });
});

describe("o caminho ANTIGO fica intacto — instalação que só tem .env", () => {
  it("handshake com o token do .env: 200, mesmo sem a tabela existir", async () => {
    // É o piso de rollback: código novo sobre banco que ainda não tem a 0257
    // (o `agent.sh` reverte a imagem, não o schema). Nada muda de resposta.
    erroDaLeitura = { code: "42P01", message: 'relation "platform_meta_app" does not exist' };
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", TOKEN_DO_ENV);

    const res = await GET(handshake(TOKEN_DO_ENV), ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CHALLENGE);
  });

  it("entrega assinada com o segredo do .env: 200 e a mensagem é ingerida", async () => {
    linhaDoBanco = null;
    vi.stubEnv("META_APP_SECRET", SEGREDO_DO_ENV);

    const res = await POST(entrega(SEGREDO_DO_ENV), ctx);

    expect(res.status).toBe(200);
    expect(ingeridos).toHaveLength(1);
  });

  it("sem nenhuma das duas fontes, o desfecho é o de hoje: 403 no handshake", async () => {
    const res = await GET(handshake("qualquer"), ctx);
    expect(res.status).toBe(403);
  });
});
