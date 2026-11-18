/**
 * RELIGAR A CONTA NÃO PODE QUEBRAR O PUBLISH (#3371, fatia 6).
 *
 * ## O que aconteceu em produção
 *
 * Ao religar a conta pela tela, `models_available` continuava VAZIO, e o
 * primeiro "Publicar" respondia `422 model_not_found`. O ramo da assinatura em
 * `POST /api/v1/ai/credentials/:id/revalidate` devolvia a credencial sem passar
 * pela listagem que o seletor de modelos usa: a lista só aparecia quando alguém
 * abria o seletor — e publicar não abre seletor.
 *
 * ## O que este arquivo mede
 *
 * Sucesso da renovação → a listagem existente é chamada com a organização, e a
 * resposta já traz `models_available` preenchido. Falha da listagem NÃO
 * transforma a revalidação em erro: o login está bom, e um 409 aqui mandaria o
 * operador reconectar uma conta que acabou de voltar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/ai/credentials/[id]/revalidate/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { renovarComTravaDeBanco } from "@/lib/ai/credenciais/login-codex";
import { listarModelosDaAssinatura } from "@/lib/ai/catalogo/modelos-da-assinatura";
import { fecharAvisoDaAssinatura } from "@/lib/ai/credenciais/aviso-da-assinatura";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/provider-validators", () => ({ validateProviderKey: vi.fn() }));
vi.mock("@/lib/ai/pontos/pkce-da-assinatura", () => ({ renovarPorRefreshToken: vi.fn() }));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({ renovarComTravaDeBanco: vi.fn() }));
vi.mock("@/lib/ai/credenciais/aviso-da-assinatura", () => ({
  fecharAvisoDaAssinatura: vi.fn(async () => "resolvido"),
}));
vi.mock("@/lib/ai/catalogo/modelos-da-assinatura", () => ({
  FalhaAoListarModelosDaAssinatura: class FalhaAoListarModelosDaAssinatura extends Error {
    motivo = "http_401";
    status = 401;
  },
  listarModelosDaAssinatura: vi.fn(),
}));

const org = "55555555-5555-4555-8555-555555555555";
const id = "66666666-6666-4666-8666-666666666666";

const linha = {
  id,
  organization_id: org,
  provider: PROVEDOR_POR_ASSINATURA,
  label: "Conta ChatGPT",
  api_key_encrypted: "\\x00",
  api_key_iv: "\\x00",
  api_key_tag: "\\x00",
  is_active: true,
};

/** A view segura, JÁ com os modelos — é o corpo que a tela recebe. */
const segura = {
  id,
  organization_id: org,
  provider: PROVEDOR_POR_ASSINATURA,
  label: "Conta ChatGPT",
  api_key_last4: null,
  validated_at: "2026-10-27T20:00:00Z",
  validation_error: null,
  models_available: ["gpt-5.6-luna", "gpt-5.6-mini"],
  is_active: true,
  created_by: "actor",
  created_at: "2026-10-20T00:00:00Z",
  updated_at: "2026-10-27T20:00:00Z",
};

function fakeAdmin() {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    from(tabela: string) {
      let op = "select";
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        update: (patch: Record<string, unknown>) => {
          op = "update";
          updates.push(patch);
          return chain;
        },
        maybeSingle: async () => {
          if (tabela === "ai_provider_credentials" && op === "select") {
            return { data: linha, error: null };
          }
          return { data: { id }, error: null };
        },
        single: async () => ({ data: segura, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: { id }, error: null }).then(resolve),
      };
      return chain;
    },
  };
}

function invocar() {
  return POST(
    new NextRequest(`http://localhost/api/v1/ai/credentials/${id}/revalidate`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: org, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue(
    fakeAdmin() as unknown as ReturnType<typeof createAdminClient>,
  );
  vi.mocked(renovarComTravaDeBanco).mockResolvedValue({
    ok: true,
    tokens: {
      access_token: "at-novo",
      refresh_token: "rt-novo",
      expires_at: Date.now() + 3_600_000,
    },
  });
  vi.mocked(listarModelosDaAssinatura).mockResolvedValue([
    {
      provider: PROVEDOR_POR_ASSINATURA,
      model_id: "gpt-5.6-luna",
      display_name: "GPT-5.6 Luna",
      description: null,
      context_window: null,
      input_price_per_million_cents: null,
      output_price_per_million_cents: null,
      supports_tools: true,
      supports_vision: true,
      is_default_for_provider: false,
      deprecated_at: null,
    },
  ] as never);
});

describe("religar a assinatura", () => {
  it("⭐ a listagem roda na hora — o publish não pode nascer sem modelo", async () => {
    const res = await invocar();

    expect(vi.mocked(listarModelosDaAssinatura), "religou sem listar modelos").toHaveBeenCalledTimes(1);
    expect(vi.mocked(listarModelosDaAssinatura).mock.calls[0]?.[0]).toBe(org);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { models_available?: unknown } };
    expect(corpo.data?.models_available).toEqual(["gpt-5.6-luna", "gpt-5.6-mini"]);
  });

  it("o aviso da Central fecha sozinho quando a credencial volta", async () => {
    await invocar();
    expect(vi.mocked(fecharAvisoDaAssinatura)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fecharAvisoDaAssinatura).mock.calls[0]?.[1]).toBe(org);
  });

  it("listagem fora do ar NÃO transforma login bom em erro na tela", async () => {
    vi.mocked(listarModelosDaAssinatura).mockRejectedValue(
      new Error("formato_de_resposta_desconhecido"),
    );

    const res = await invocar();

    expect(res.status).toBe(200);
    expect(vi.mocked(fecharAvisoDaAssinatura)).toHaveBeenCalledTimes(1);
  });
});
