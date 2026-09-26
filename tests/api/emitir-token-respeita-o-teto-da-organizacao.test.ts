/**
 * O EMISSOR DEVOLVE A RECUSA DO TETO COMO 409 — E COM A MENSAGEM DO BANCO.
 *
 * A trava é do banco (migration 0415, gatilho `trg_teto_de_tokens_ativos`), e
 * o gatilho levanta SQLSTATE `PT409` com uma frase própria: diz o limite e manda
 * revogar um token para liberar espaço. Sem este ramo, `POST
 * /api/v1/settings/api-tokens` devolvia `500 internal_error` com o mesmo texto
 * solto — a pessoa via "erro interno" para uma recusa que é dela, e o toast da
 * tela (`onError: showApiError`) propagava o 500.
 *
 * O que se cobre aqui é a tradução: código → status → código de contrato de
 * wire, e a mensagem passada VERBATIM (uma cópia em TypeScript seria a segunda
 * fonte do limite — o número mora no corpo da função, e é o banco quem o sabe).
 * Os três casos do teto em si (passa / recusa / revogado libera) estão em
 * `tests/invariants/teto-de-tokens-ativos-da-organizacao.test.ts`, contra
 * Postgres real: um gatilho não existe em unitário com dublê.
 */
import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  audit: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ insert: () => ({ select: () => ({ single: deps.single }) }) }),
  }),
}));

import { POST } from "@/app/api/v1/settings/api-tokens/route";
import { ApiErrorCodes } from "@/lib/api/errors";
import { NextRequest } from "next/server";

/** A frase que o gatilho levanta, tal como o Postgres a devolve. */
const MENSAGEM_DO_BANCO =
  "Teto de tokens ativos por organização atingido: 50 de 50. Revogue um token que não esteja mais em uso " +
  "(Configurações → Tokens de API → Revogar) para liberar espaço — tokens revogados ou expirados não contam " +
  "— e tente criar outro.";

const request = () =>
  new NextRequest("http://localhost/api/v1/settings/api-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "integracao", scopes: ["mcp:read"] }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "human", idioma: "pt-BR" },
    org: { orgId: "org-teto" },
  });
});

it("no teto, a emissão devolve 409 com a mensagem do banco, verbatim", async () => {
  deps.single.mockResolvedValue({ data: null, error: { code: "PT409", message: MENSAGEM_DO_BANCO } });

  const res = await POST(request());
  expect(res.status).toBe(409);

  const corpo = (await res.json()) as { error: { code: string; message: string } };
  expect(corpo.error.code).toBe("api_token_teto_atingido");
  expect(corpo.error.message).toBe(MENSAGEM_DO_BANCO);
  // A mensagem tem de continuar dizendo o QUE FAZER, não só que deu erro.
  expect(corpo.error.message).toContain("Teto de tokens ativos por organização atingido");
  expect(corpo.error.message).toContain("50 de 50");
  expect(corpo.error.message).toContain("Revogue um token");

  // Recusa não é criação: nada de audit `token.created` no caminho.
  expect(deps.audit).not.toHaveBeenCalled();
});

it("o código do teto é contrato de wire declarado — não uma string solta no call site", () => {
  expect(ApiErrorCodes.api_token_teto_atingido).toBe("api_token_teto_atingido");
});

it("erro que não é o teto continua sendo internal_error 500", async () => {
  deps.single.mockResolvedValue({ data: null, error: { code: "XX000", message: "qualquer quebra" } });

  const res = await POST(request());
  expect(res.status).toBe(500);

  const corpo = (await res.json()) as { error: { code: string; message: string } };
  expect(corpo.error.code).toBe("internal_error");
  expect(corpo.error.code).not.toBe("api_token_teto_atingido");
  expect(deps.audit).not.toHaveBeenCalled();
});

it("dentro do teto a emissão segue devolvendo o token uma única vez, com audit", async () => {
  deps.single.mockResolvedValue({
    data: { id: "tok-1", name: "integracao", prefix: "dsk_abcd1234" },
    error: null,
  });

  const res = await POST(request());
  expect(res.status).toBe(201);

  const corpo = (await res.json()) as { data: { plaintext: string; _warning: string } };
  expect(corpo.data.plaintext).toMatch(/^dsk_[0-9a-f]{8}_/);
  expect(deps.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "token.created", organizationId: "org-teto" }),
  );
});
