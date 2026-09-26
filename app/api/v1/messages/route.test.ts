/**
 * POST /api/v1/messages — por TOKEN leva teto de chamadas e o freio anti-ban do
 * número; pela SESSÃO do navegador, não leva nenhum dos dois (quem digita é uma
 * pessoa). Ver `lib/messaging/ritmo-do-envio-por-token.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));
vi.mock("./_handler", () => ({ sendMessageHandler: vi.fn() }));

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";

import { sendMessageHandler } from "./_handler";
import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const mockedAuth = vi.mocked(resolveAuthDual);
const mockedTeto = vi.mocked(checkRateLimit);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);
const mockedSend = vi.mocked(sendMessageHandler);

// ─── Banco falso de estado (#1613) ────────────────────────────────────────────
// Três tabelas com as cadeias EXATAS que a rota e o helper `comIdempotencia`
// encadeiam (`select`/`eq`/`is`/`gt`/`insert`/`update`/`maybeSingle`/await).
// O helper roda de VERDADE — não é mockado: o que se mede é a integração entre
// a rota e ele, e o número que decide o caso é a CONTAGEM de envios, não a
// igualdade das respostas (um caminho que devolvesse a resposta gravada e
// mandasse de novo passaria na igualdade e duplicaria a mensagem).
type Linha = Record<string, unknown>;

const PESSOA = "99999999-1111-4111-8111-111111111111";
const CHAVE = "aaaaaaa1-1111-4111-8111-111111111111";

function bancoFalso() {
  // Nomeado, e não `Record<string, …>`: com índice de string aberto, o
  // `noUncheckedIndexedAccess` trata CADA acesso como possivelmente indefinido
  // — e as três tabelas deste teste sempre existem.
  const tabelas: {
    idempotency_keys: Linha[];
    user_organizations: Linha[];
    api_tokens: Linha[];
  } = {
    idempotency_keys: [],
    user_organizations: [
      { user_id: PESSOA, organization_id: ORG_ID, role: "agent", revoked_at: null },
    ],
    api_tokens: [{ id: "tok-1", organization_id: ORG_ID, name: "ERP Externo" }],
  };

  const from = (nome: string) => {
    const linhas = (tabelas as Record<string, Linha[]>)[nome] ?? [];
    const eq: Array<[string, unknown]> = [];
    const isNull: Array<[string, unknown]> = [];
    let gt: [string, unknown] | null = null;
    let patch: Linha | null = null;
    let inserindo: Linha | null = null;

    const casa = (l: Linha) =>
      eq.every(([c, v]) => l[c] === v) &&
      isNull.every(([c, v]) => l[c] === v) &&
      (gt ? String(l[gt[0]]) > String(gt[1]) : true);
    const aplicar = () => {
      if (patch) {
        for (const l of linhas.filter(casa)) Object.assign(l, patch);
        patch = null;
      }
      if (inserindo) {
        linhas.push(inserindo);
        inserindo = null;
      }
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (eq.push([c, v]), b);
    b.is = (c: string, v: unknown) => (isNull.push([c, v]), b);
    b.gt = (c: string, v: unknown) => ((gt = [c, v]), b);
    b.insert = (l: Linha) => ((inserindo = l), b);
    b.update = (p: Linha) => ((patch = p), b);
    b.maybeSingle = async () => {
      aplicar();
      return { data: linhas.find(casa) ?? null, error: null };
    };
    b.single = async () => {
      aplicar();
      const l = linhas.find(casa);
      return { data: l ?? null, error: l ? null : { message: "no rows" } };
    };
    b.then = (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
      aplicar();
      return Promise.resolve({ data: null, error: null }).then(comOk, comErro);
    };
    return b;
  };

  return {
    tabelas,
    supabase: {
      from,
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: { user_metadata: { full_name: "Fulano da Silva" } } },
            error: null,
          }),
        },
      },
    },
  };
}

/** Estado novo por chamada: um recibo de um teste não pode vazar para o próximo. */
let banco = bancoFalso();

// Este mock JÁ entrega `scopes` no ramo do token, então não prova que
// `resolveAuthDual` os preenche. Quem prova é `lib/api/auth-dual.test.ts`
// ("devolve os scopes e o id da linha do token") — sem ele, o "em nome de"
// ficou morto em produção com esta suíte verde (#1676).
function autenticado(via: "session" | "token", scopes?: string[]) {
  banco = bancoFalso();
  mockedAuth.mockResolvedValue({
    ok: true,
    organizationId: ORG_ID,
    actor: via === "token" ? { type: "api_token", id: "tok-1" } : { type: "user", id: "u1" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: banco.supabase as any,
    via,
    ...(via === "token"
      ? { scopes: scopes ?? ["mcp:read", "mcp:write"], apiTokenId: "tok-1" }
      : {}),
  });
}

function pedido(opcoes: { chave?: string; corpo?: Record<string, unknown> } = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opcoes.chave ? { "Idempotency-Key": opcoes.chave } : {}),
    },
    body: JSON.stringify({
      conversation_id: CONVERSATION_ID,
      type: "text",
      body: "Oi!",
      ...(opcoes.corpo ?? {}),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTeto.mockResolvedValue({ allowed: true } as never);
  mockedSegurar.mockResolvedValue(null);
  mockedSend.mockResolvedValue({ id: "m1", status: "sent" } as never);
});

describe("POST /api/v1/messages — idempotência (#1613, item A)", () => {
  it("mesma Idempotency-Key: DUAS chamadas, UM envio, a MESMA resposta", async () => {
    autenticado("token");

    const primeira = await POST(pedido({ chave: CHAVE }));
    const segunda = await POST(pedido({ chave: CHAVE }));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    // A prova é a CONTAGEM de envios — ver o cabeçalho do banco falso acima.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(await segunda.json()).toEqual(await primeira.json());
    // A retentativa não gastou o freio de chamadas nem o freio anti-ban: ela
    // devolveu o recibo, e contador de uma chamada que não aconteceu seria
    // mentira (a cota de uma integração em laço cairia com retentativas).
    expect(mockedTeto).toHaveBeenCalledTimes(2); // 1 execução × (token + org)
    expect(mockedSegurar).toHaveBeenCalledTimes(1);
    expect(mockedRegistrar).toHaveBeenCalledTimes(1);
  });

  it("mesma chave com corpo DIFERENTE devolve 409 idempotency_conflict e não reenvia", async () => {
    autenticado("token");

    const primeira = await POST(pedido({ chave: CHAVE }));
    const segunda = await POST(pedido({ chave: CHAVE, corpo: { body: "Outra cobrança." } }));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(409);
    const corpo = (await segunda.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("idempotency_conflict");
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it("sem a chave, o comportamento é o de antes: envia a cada chamada e não grava recibo", async () => {
    autenticado("token");

    await POST(pedido());
    await POST(pedido());

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(banco.tabelas.idempotency_keys).toHaveLength(0);
  });

  it("chave malformada é recusada antes de qualquer efeito, sem recibo", async () => {
    autenticado("token");

    const res = await POST(pedido({ chave: "nao-e-uuid" }));

    expect(res.status).toBe(400);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(banco.tabelas.idempotency_keys).toHaveLength(0);
  });
});

describe("POST /api/v1/messages — autoria em nome de (#1613, item C)", () => {
  it("sem o escopo messages:on_behalf, o campo é recusado e NADA é enviado", async () => {
    autenticado("token", ["mcp:read", "mcp:write"]);

    const res = await POST(pedido({ corpo: { on_behalf_of_user_id: PESSOA } }));

    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("pela SESSÃO do navegador o campo é recusado — escopo é coisa de token", async () => {
    autenticado("session");

    const res = await POST(pedido({ corpo: { on_behalf_of_user_id: PESSOA } }));

    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("com escopo e membro agent+ ATIVO, envia e entrega a pessoa no ctx", async () => {
    autenticado("token", ["mcp:write", "messages:on_behalf"]);

    const res = await POST(pedido({ corpo: { on_behalf_of_user_id: PESSOA } }));

    expect(res.status).toBe(201);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // Os dois nomes são lidos no servidor, para irem gravados na linha: o balão
    // desenha "Fulano · via {token}" sem join.
    expect(mockedSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        onBehalfOf: { userId: PESSOA, userName: "Fulano da Silva", tokenName: "ERP Externo" },
      }),
      expect.anything(),
    );
  });

  it("usuário de OUTRA organização é recusado (a org vem da linha do token)", async () => {
    autenticado("token", ["mcp:write", "messages:on_behalf"]);
    banco.tabelas.user_organizations = [
      { user_id: PESSOA, organization_id: "outra-org", role: "admin", revoked_at: null },
    ];

    const res = await POST(pedido({ corpo: { on_behalf_of_user_id: PESSOA } }));

    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("membro REVOGADO é recusado", async () => {
    autenticado("token", ["mcp:write", "messages:on_behalf"]);
    banco.tabelas.user_organizations[0]!.revoked_at = "2026-09-01T00:00:00.000Z";

    const res = await POST(pedido({ corpo: { on_behalf_of_user_id: PESSOA } }));

    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("viewer (abaixo de atendente) é recusado", async () => {
    autenticado("token", ["mcp:write", "messages:on_behalf"]);
    banco.tabelas.user_organizations[0]!.role = "viewer";

    const res = await POST(pedido({ corpo: { on_behalf_of_user_id: PESSOA } }));

    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/messages — ritmo por token", () => {
  it("pela sessão do navegador, não aplica teto nem freio", async () => {
    autenticado("session");
    const res = await POST(pedido());
    expect(res.status).toBe(201);
    expect(mockedTeto).not.toHaveBeenCalled();
    expect(mockedSegurar).not.toHaveBeenCalled();
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });

  it("por token, passa pelo freio antes de enviar e conta o envio", async () => {
    autenticado("token");
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);

    const res = await POST(pedido());

    expect(res.status).toBe(201);
    expect(mockedTeto).toHaveBeenCalledWith("messages:tok:tok-1", expect.any(Number), expect.any(Number));
    expect(mockedTeto).toHaveBeenCalledWith(`messages:org:${ORG_ID}`, expect.any(Number), expect.any(Number));
    expect(mockedSegurar.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedSend.mock.invocationCallOrder[0]!,
    );
    expect(mockedRegistrar).toHaveBeenCalledWith(expect.anything(), ORG_ID, segurado, "sent");
  });

  it("por token, acima do teto de chamadas por token devolve 429 sem enviar", async () => {
    autenticado("token");
    mockedTeto.mockResolvedValueOnce({ allowed: false } as never);

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("por token, acima do teto da organização devolve 429 sem enviar", async () => {
    autenticado("token");
    mockedTeto.mockResolvedValueOnce({ allowed: true } as never); // token ok
    mockedTeto.mockResolvedValueOnce({ allowed: false } as never); // org limit

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("por token, quando o número estourou o teto diário devolve 429 com Retry-After", async () => {
    autenticado("token");
    mockedSegurar.mockRejectedValue(
      new ApiError(
        429,
        "rate_limited",
        { motivo: "teto_diario", libera_em: "2026-09-23T03:00:00.000Z", retry_after_seconds: 43_200 },
        "req",
      ),
    );

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("43200");
    const corpo = (await res.json()) as { error: { code: string; details?: { motivo?: string } } };
    expect(corpo.error.code).toBe("rate_limited");
    expect(corpo.error.details?.motivo).toBe("teto_diario");
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("422 janela_fechada chega ao CORPO com o detalhe — quem integra lê `use` e o código", async () => {
    // A recusa da janela (#1614) só vale se o detalhe atravessar a rota: sem
    // ele, o integrador recebe um 422 sem saber que a saída é modelo aprovado.
    autenticado("token");
    mockedSend.mockRejectedValue(
      new ApiError(
        422,
        "janela_fechada",
        {
          codigo: "janela_fechada",
          ultima_mensagem_do_cliente: "2026-09-20T10:00:00.000Z",
          use: "template",
          codigo_plataforma: "131047",
        },
        "req",
        "Janela de 24 horas fechada.",
      ),
    );

    const res = await POST(pedido());

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(corpo.error.code).toBe("janela_fechada");
    expect(corpo.error.details).toMatchObject({
      codigo: "janela_fechada",
      ultima_mensagem_do_cliente: "2026-09-20T10:00:00.000Z",
      use: "template",
      codigo_plataforma: "131047",
    });
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });
});
