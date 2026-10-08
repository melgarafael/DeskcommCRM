/**
 * /api/v1/ai/providers — a assinatura do ChatGPT (#1639) segue o módulo `login_codex`.
 *
 * Desligado (o padrão; doc 73: nada aparece para as empresas), o painel de
 * Provedores não oferece "OpenAI pela assinatura (ChatGPT)", não mostra a linha
 * do login entre as credenciais, e nenhuma escrita (PUT do ponto, PATCH do
 * padrão) grava a assinatura. Ligado, tudo segue como antes. Banco que não
 * respondeu = desligado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";

const banco = vi.hoisted(() => ({
  /** `ligado` / `desligado` / `erro` — o estado de `platform_config` visto pelo admin. */
  modulo: "desligado" as "ligado" | "desligado" | "erro",
  credenciais: [] as Array<Record<string, unknown>>,
  gravacoes: [] as Array<{ tabela: string; payload: unknown }>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

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
        if (banco.modulo === "erro") throw new Error("banco fora do ar");
        return cadeia(tabela, [{ chave: "MODULO_LOGIN_CODEX", valor: banco.modulo }], null);
      }
      if (tabela === "modulos_instalados") return cadeia(tabela, [], null);
      // `organizations` — o PATCH do padrão.
      return cadeia(tabela, [], { settings: {} });
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      if (tabela === "ai_provider_credentials") return cadeia(tabela, banco.credenciais, null);
      if (tabela === "ai_models") {
        return cadeia(tabela, [], { model_id: "gpt-5.5", supports_tools: true, supports_vision: false });
      }
      if (tabela === "ai_purpose_bindings") {
        return cadeia(tabela, [], {
          id: "33333333-3333-4333-8333-333333333333",
          purpose: "stage_classifier",
          provider: "openai-assinatura",
          model_id: "gpt-5.5",
        });
      }
      return cadeia(tabela, [], null);
    },
  }),
}));

import { GET, PATCH, PUT } from "@/app/api/v1/ai/providers/route";

const ASSINATURA = "openai-assinatura";

function requisicao(metodo: "PUT" | "PATCH", corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/providers", {
    method: metodo,
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

async function painel() {
  const res = await GET();
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as {
    data: { provedores: Array<{ id: string }>; credenciais: Array<{ provider: string }> };
  };
  return {
    provedores: corpo.data.provedores.map((p) => p.id),
    credenciais: corpo.data.credenciais.map((c) => c.provider),
  };
}

const putDaAssinatura = () =>
  PUT(requisicao("PUT", { purpose: "stage_classifier", provider: ASSINATURA, model_id: "gpt-5.5" }));
const patchDaAssinatura = () =>
  PATCH(requisicao("PATCH", { provider: ASSINATURA, default_model: "gpt-5.5" }));

beforeEach(() => {
  vi.clearAllMocks();
  banco.gravacoes = [];
  banco.credenciais = [
    { id: "c1", provider: "anthropic", label: "a", api_key_last4: "c0de", validated_at: "2026-10-01T00:00:00Z", is_active: true },
    { id: "c2", provider: ASSINATURA, label: "login", api_key_last4: "c0de", validated_at: "2026-10-01T00:00:00Z", is_active: true },
  ];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

describe.each(["desligado", "erro"] as const)("módulo login_codex %s", (estado) => {
  beforeEach(() => {
    banco.modulo = estado;
  });

  it("GET não oferece a assinatura nem mostra a linha do login", async () => {
    const { provedores, credenciais } = await painel();
    expect(provedores).not.toContain(ASSINATURA);
    // Os demais continuam: o filtro tira só a assinatura.
    expect(provedores).toContain("anthropic");
    expect(provedores).toContain("openai");
    expect(credenciais).toEqual(["anthropic"]);
  });

  it("PUT com a assinatura responde 422 e não grava", async () => {
    const res = await putDaAssinatura();
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("provedor_desligado");
    expect(corpo.error.message).toMatch(/assinatura/i);
    expect(banco.gravacoes).toEqual([]);
  });

  it("PATCH do padrão com a assinatura responde 422 e não grava", async () => {
    const res = await patchDaAssinatura();
    expect(res.status).toBe(422);
    expect(banco.gravacoes).toEqual([]);
  });
});

describe("módulo login_codex ligado — igual a antes", () => {
  beforeEach(() => {
    banco.modulo = "ligado";
  });

  it("GET oferece a assinatura e mostra a linha do login", async () => {
    const { provedores, credenciais } = await painel();
    expect(provedores).toContain(ASSINATURA);
    expect(credenciais).toEqual(["anthropic", ASSINATURA]);
  });

  it("PUT com a assinatura grava", async () => {
    const res = await putDaAssinatura();
    expect(res.status).toBe(200);
    expect(banco.gravacoes.map((g) => g.tabela)).toEqual(["ai_purpose_bindings"]);
  });

  it("PATCH do padrão com a assinatura grava", async () => {
    const res = await patchDaAssinatura();
    expect(res.status).toBe(200);
    expect(banco.gravacoes.map((g) => g.tabela)).toEqual(["organizations"]);
  });
});
