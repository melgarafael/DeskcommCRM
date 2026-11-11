// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * #4107 — em três rotas representativas, a resposta MONTADA À MÃO leva o
 * `X-Request-Id` da requisição, e o valor é o MESMO do registro daquela
 * requisição (o id que a rota usa no `audit`/log), não um UUID novo.
 *
 * As três cobrem os formatos que não passam por `ok()`/`fail()`:
 *
 *  1. JSON    — `GET /api/v1/health` (200 + `NextResponse.json`).
 *  2. erro    — `POST /api/v1/admin/platform-admins` (405 montado à mão).
 *  3. export  — `GET /api/v1/contacts/export` (arquivo; o id também vai ao audit).
 *
 * O que NÃO se mede aqui, de propósito: o corpo e o status de cada rota já têm
 * teste próprio (`route.test.ts` ao lado); as asserções de corpo abaixo existem
 * só para provar que o carimbo não os trocou.
 */

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://projeto.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
    SUPABASE_SERVER_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-de-teste",
    UPSTASH_REDIS_REST_URL: "https://redis.exemplo",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    WAHA_API_BASE_URL: "https://waha.exemplo",
    WAHA_API_KEY: "chave-waha",
    INTERNAL_CRON_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
    INTERNAL_SECRET: "",
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ listContactsHandler: vi.fn() }));

function pedido(url: string): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": ID } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER_ID,
      email: "gerente@exemplo.com",
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
    },
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as never);
  vi.mocked(listContactsHandler).mockResolvedValue({
    contacts: [],
    cursor: null,
    has_more: false,
  } as never);
});

describe("JSON — GET /api/v1/health", () => {
  it("a resposta montada à mão sai com o id da requisição, e status/corpo seguem iguais", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entrada: RequestInfo | URL) => {
        const url = String(entrada);
        // PostgREST recusando a anon key: chegamos ao banco, é `ok`.
        if (url.includes("/rest/v1/organizations")) return new Response("", { status: 401 });
        return Response.json([]);
      }),
    );
    const { GET } = await import("@/app/api/v1/health/route");

    const res = await GET(pedido("https://crm.exemplo/api/v1/health"));
    vi.unstubAllGlobals();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe(ID);
    // O corpo é o de sempre: o carimbo não é desculpa para mexer no contrato.
    expect((await res.json()).data.status).toBe("healthy");
  });
});

describe("erro montado à mão — POST /api/v1/admin/platform-admins", () => {
  it("o 405 leva o mesmo id da requisição, com Allow e corpo intactos", async () => {
    const { POST } = await import("@/app/api/v1/admin/platform-admins/route");

    const res = await POST(pedido("https://crm.exemplo/api/v1/admin/platform-admins"));

    expect(res.status).toBe(405);
    expect(res.headers.get("X-Request-Id")).toBe(ID);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(await res.json()).toMatchObject({ error: { code: "method_not_allowed" } });
  });
});

describe("export — GET /api/v1/contacts/export", () => {
  it("o arquivo leva o id que foi para o audit daquela requisição", async () => {
    const { GET } = await import("@/app/api/v1/contacts/export/route");

    const res = await GET(pedido("https://crm.exemplo/api/v1/contacts/export?formato=csv"));

    expect(res.status).toBe(200);
    const idDaResposta = res.headers.get("X-Request-Id");
    expect(idDaResposta).toMatch(UUID);

    // Igualdade com o REGISTRO: o `audit` da rota recebe o MESMO id que o
    // cliente vê no cabeçalho — é o que torna o `ID:` da tela procurável.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "contacts.exported",
      requestId: idDaResposta,
    });
    // O arquivo continua sendo o CSV de sempre.
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(await res.text()).toContain("name,display_name,email,phone_number,cpf,birthdate,tags");
  });
});
