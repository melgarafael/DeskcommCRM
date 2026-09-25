/**
 * GET /api/v1/ai/providers — as credenciais do painel são só as de quem CONVERSA.
 *
 * O painel mostra "Você ainda não cadastrou nenhuma chave de provedor" quando a
 * lista vem vazia, e cada ponto dele escolhe modelo de linguagem. A chave do Jev
 * (que só decide) contada aqui apagaria esse aviso numa empresa sem IA para
 * atender — e apareceria como opção de chave num ponto que não sabe usá-la.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

const banco = vi.hoisted(() => ({ credenciais: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const dados = tabela === "ai_provider_credentials" ? banco.credenciais : [];
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: dados, error: null }).then(ok, erro),
      };
      for (const m of ["select", "eq", "is", "not", "order", "limit"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/ai/providers/route";

function linha(provider: string) {
  return { id: `cred-${provider}`, provider, label: provider, api_key_last4: "c0de", validated_at: "2026-09-23T12:00:00Z", is_active: true };
}

async function credenciaisDoPainel(): Promise<string[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as { data: { credenciais: Array<{ provider: string }> } };
  return corpo.data.credenciais.map((c) => c.provider);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

describe("GET /api/v1/ai/providers — credenciais", () => {
  it("só a chave do Jev: a lista vem vazia, e o aviso de 'sem chave' continua de pé", async () => {
    banco.credenciais = [linha("typesafe")];
    expect(await credenciaisDoPainel()).toEqual([]);
  });

  it("chave de quem conversa passa; a do Jev fica de fora", async () => {
    // Controle positivo: sem ele, uma rota que devolvesse sempre [] passaria.
    banco.credenciais = [linha("typesafe"), linha("anthropic"), linha("openai")];
    expect(await credenciaisDoPainel()).toEqual(["anthropic", "openai"]);
  });
});
