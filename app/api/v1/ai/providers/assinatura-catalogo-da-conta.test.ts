/**
 * PUT/PATCH /api/v1/ai/providers com a assinatura do ChatGPT — o catálogo é o
 * DA CONTA, não o `ai_models` global (#2931).
 *
 * Os modelos da assinatura não entram em `ai_models`: antes do #2931 todo PUT
 * da assinatura saía como "modelo desconhecido" (grava, com aviso). Agora a rota
 * consulta a lista da conta conectada e reconhece o modelo que está nela.
 *
 * E a consulta é rede: ela pode falhar (401/403, timeout). Essa falha NÃO pode
 * derrubar a gravação com um 500 cru — degrada para o caminho que já existia
 * (grava, com o aviso de que não deu para verificar).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";

const banco = vi.hoisted(() => ({
  gravacoes: [] as Array<{ tabela: string; payload: unknown }>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({ access_token: "at" })),
}));

function cadeia(tabela: string, dados: unknown, unico: unknown) {
  const chain: Record<string, unknown> = {
    maybeSingle: async () => ({ data: unico, error: null }),
    upsert: (payload: unknown) => {
      banco.gravacoes.push({ tabela, payload });
      return chain;
    },
    update: (payload: unknown) => {
      banco.gravacoes.push({ tabela, payload });
      return chain;
    },
    then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
      Promise.resolve({ data: dados, error: null }).then(ok, erro),
  };
  for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) chain[m] = () => chain;
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "platform_config") {
        return cadeia(tabela, [{ chave: "MODULO_LOGIN_CODEX", valor: "ligado" }], null);
      }
      if (tabela === "modulos_instalados") return cadeia(tabela, [], null);
      // A credencial da assinatura (o espelho `models_available` é regravado nela).
      if (tabela === "ai_provider_credentials") return cadeia(tabela, [], null);
      return cadeia(tabela, [], { settings: {} });
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      // O catálogo GLOBAL não tem linha da assinatura — é o estado real.
      if (tabela === "ai_models") return cadeia(tabela, [], null);
      if (tabela === "ai_purpose_bindings") {
        return cadeia(tabela, [], {
          id: "33333333-3333-4333-8333-333333333333",
          purpose: "stage_classifier",
          provider: "openai-assinatura",
          model_id: "gpt-da-conta",
        });
      }
      return cadeia(tabela, [], null);
    },
  }),
}));

import { PATCH, PUT } from "@/app/api/v1/ai/providers/route";

const AVISO_DE_DESCONHECIDO = /não está no catálogo|não conseguimos verificar|não deu para conferir/i;

function requisicao(metodo: "PUT" | "PATCH", corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/providers", {
    method: metodo,
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const put = () =>
  PUT(requisicao("PUT", { purpose: "stage_classifier", provider: "openai-assinatura", model_id: "gpt-da-conta" }));
const patch = () =>
  PATCH(requisicao("PATCH", { provider: "openai-assinatura", default_model: "gpt-da-conta" }));

function catalogoDaConta(resposta: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(resposta));
}

beforeEach(() => {
  vi.clearAllMocks();
  banco.gravacoes = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("o modelo está na lista da conta", () => {
  beforeEach(() => {
    catalogoDaConta(async () =>
      Response.json({ models: [{ slug: "gpt-da-conta", visibility: "list" }] }),
    );
  });

  it("PUT grava SEM o aviso de modelo desconhecido", async () => {
    const res = await put();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { avisos: string[] } };
    expect(corpo.data.avisos.join(" ")).not.toMatch(AVISO_DE_DESCONHECIDO);
  });

  it("PATCH grava SEM o aviso de modelo desconhecido", async () => {
    const res = await patch();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { avisos: string[] } };
    expect(corpo.data.avisos.join(" ")).not.toMatch(AVISO_DE_DESCONHECIDO);
  });
});

describe("a consulta da lista da conta falha (403)", () => {
  beforeEach(() => {
    catalogoDaConta(async () => Response.json({ error: { message: "Missing scopes" } }, { status: 403 }));
  });

  it("PUT não vira 500: grava, com o aviso de que não deu para verificar", async () => {
    const res = await put();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { avisos: string[] } };
    expect(corpo.data.avisos.join(" ")).toMatch(AVISO_DE_DESCONHECIDO);
    expect(banco.gravacoes.map((g) => g.tabela)).toContain("ai_purpose_bindings");
  });

  it("PATCH não vira 500: grava, com o aviso de que não deu para verificar", async () => {
    const res = await patch();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { avisos: string[] } };
    expect(corpo.data.avisos.join(" ")).toMatch(AVISO_DE_DESCONHECIDO);
    expect(banco.gravacoes.map((g) => g.tabela)).toContain("organizations");
  });
});
