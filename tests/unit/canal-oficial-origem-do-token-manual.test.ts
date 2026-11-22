/**
 * A porta manual GRAVA a origem dela — e não aceita a que o cliente mandar (#4074).
 *
 * O contrato de `lib/channels/meta/origem-da-conexao.ts` prova o vocabulário e a
 * gravação isolados. O que só a ROTA prova é a metade que importa para a
 * auditoria: `/api/v1/channels/official` é a porta do token colado à mão, então
 * ela grava `token_manual` sempre — inclusive quando o corpo do request tenta
 * dizer `embedded_signup`. Procedência que o cliente escolhe não é procedência.
 *
 * E prova o piso de rollback: banco anterior à migration 9328 recusa a coluna
 * (42703) e a conexão CONTINUA conectada — a resposta diz que a origem não foi
 * gravada, em vez de desfazer o canal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/channels/official/route";

const ORG = "org-1";
const USER = "user-1";
const NUMERO = "111222333444555";
const WABA = "999888777666555";

type Linha = Record<string, unknown>;

interface Chamada {
  tabela: string;
  op: "select" | "update" | "insert";
  patch: Linha | null;
  colunas: string;
  filtros: Array<[string, unknown]>;
}

/** Dublê do client de service role: registra o que foi escrito, na ordem. */
function banco(opts: { recusaColunaDaOrigem?: boolean } = {}) {
  const chamadas: Chamada[] = [];

  function no(
    tabela: string,
    op: Chamada["op"],
    patch: Linha | null,
    resultado: () => Promise<{ data: unknown; error: unknown }>,
  ) {
    const chamada: Chamada = { tabela, op, patch, colunas: "", filtros: [] };
    chamadas.push(chamada);
    const api = {
      select(colunas?: string) {
        chamada.colunas = colunas ?? "";
        return api;
      },
      eq(coluna: string, valor: unknown) {
        chamada.filtros.push([coluna, valor]);
        return api;
      },
      is(coluna: string, valor: unknown) {
        chamada.filtros.push([coluna, valor]);
        return api;
      },
      maybeSingle() {
        return resultado();
      },
      then<T>(ok: (v: unknown) => T, falha?: (e: unknown) => T) {
        return resultado().then(ok, falha);
      },
    };
    return api;
  }

  const client = {
    from(tabela: string) {
      return {
        select: (colunas?: string) =>
          no(tabela, "select", null, async () => ({ data: null, error: null })).select(colunas),
        insert: (patch: Linha) =>
          no(tabela, "insert", patch, async () => ({
            data: { id: "sessao-nova", webhook_path_token: "tok-do-caminho" },
            error: null,
          })),
        update: (patch: Linha) => {
          const ehOrigem = Object.keys(patch).includes("meta_connection_origin");
          return no(tabela, "update", patch, async () =>
            ehOrigem && opts.recusaColunaDaOrigem
              ? { data: null, error: { code: "42703", message: "column does not exist" } }
              : { data: null, error: null },
          );
        },
      };
    },
  };

  return { client, chamadas };
}

let fake = banco();

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    org: { orgId: ORG },
    user: { id: USER, idioma: "pt-BR", is_platform_admin: false, support: false },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => fake.client) }));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: vi.fn(async () => ({
    ok: true,
    displayPhoneNumber: "5511999998888",
    verifiedName: "Loja",
    qualityRating: "GREEN",
  })),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
  decryptWebhookSecret: vi.fn(async () => null),
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: vi.fn(async () => ({ appSecret: null, verifyToken: null })),
  appDaMetaDoAmbiente: vi.fn(() => ({ appSecret: null, verifyToken: null })),
}));
vi.mock("@/lib/channels/meta/webhook-da-sessao", () => ({
  registrarWebhookDaSessao: vi.fn(async () => null),
  COLUNAS_DO_DESFECHO_DO_WEBHOOK: "meta_webhook_override_uri",
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));


function pedido(corpo: Linha): NextRequest {
  return new NextRequest("https://crm.exemplo.com/api/v1/channels/official", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://crm.exemplo.com" },
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  fake = banco();
  vi.clearAllMocks();
});

describe("conectar pela aba oficial grava a origem do TOKEN MANUAL", () => {
  it("grava token_manual mesmo quando o corpo pede embedded_signup", async () => {
    const res = await POST(
      pedido({
        phone_number_id: NUMERO,
        waba_id: WABA,
        token: "EAAG-token-de-usuario-de-sistema",
        origem: "embedded_signup",
      }),
    );
    const corpo = (await res.json()) as { data: { origem: { valor: string }; origemGravada: boolean } };

    expect(res.status).toBe(200);
    expect(corpo.data.origem.valor).toBe("token_manual");
    expect(corpo.data.origemGravada).toBe(true);

    const escrito = fake.chamadas.find(
      (c) => c.op === "update" && c.patch && "meta_connection_origin" in c.patch,
    );
    expect(escrito?.patch).toEqual({ meta_connection_origin: "token_manual" });
    expect(escrito?.filtros).toEqual([
      ["organization_id", ORG],
      ["id", "sessao-nova"],
    ]);
  });

  it("banco sem a coluna não desfaz a conexão: responde conectado e diz que não gravou", async () => {
    fake = banco({ recusaColunaDaOrigem: true });
    const res = await POST(pedido({ phone_number_id: NUMERO, waba_id: WABA, token: "EAAG-token-de-usuario-de-sistema" }));
    const corpo = (await res.json()) as { data: { connected: boolean; origemGravada: boolean } };

    expect(res.status).toBe(200);
    expect(corpo.data.connected).toBe(true);
    expect(corpo.data.origemGravada).toBe(false);
  });
});
