// @vitest-environment node
/**
 * #5179 — o PATCH de `/api/v1/settings/prospeccao` grava a fatia INTEIRA, e o
 * card da voz ("Salvar personalização") manda só os campos da voz. Sem a
 * preservação da rota, salvar a voz desligaria a opção de não pausar a IA sem
 * ninguém ver. Desligar continua possível, com `false` explícito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

import { PATCH } from "@/app/api/v1/settings/prospeccao/route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    organizationId: "org-1",
    actor: { type: "user", id: "u-1" },
    idioma: "pt-BR",
    apiTokenId: null,
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

/** Uma organização em memória: `select…maybeSingle` lê, `update…eq` grava. */
function bancoCom(settings: Record<string, unknown>) {
  const linha = { settings };
  const cliente = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linha, error: null }) }) }),
      update: (novo: { settings: Record<string, unknown> }) => ({
        eq: async () => {
          linha.settings = novo.settings;
          return { error: null };
        },
      }),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue(cliente as unknown as ReturnType<typeof createAdminClient>);
  return linha;
}

function patch(corpo: Record<string, unknown>) {
  return PATCH(
    new NextRequest("http://localhost/api/v1/settings/prospeccao", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/v1/settings/prospeccao — o interruptor da pausa sobrevive ao save da voz", () => {
  it("corpo só com a voz: grava a voz nova e mantém o interruptor ligado", async () => {
    const linha = bancoCom({
      outra: 1,
      prospeccao: { vendedor_nome: "Ana", nao_pausar_antes_da_primeira_resposta: true },
    });

    const res = await patch({ vendedor_nome: "Bia" });

    expect(res.status).toBe(200);
    expect(linha.settings).toEqual({
      outra: 1,
      prospeccao: { vendedor_nome: "Bia", nao_pausar_antes_da_primeira_resposta: true },
    });
    const corpo = (await res.json()) as { data: { personalizacao: Record<string, unknown> } };
    expect(corpo.data.personalizacao.nao_pausar_antes_da_primeira_resposta).toBe(true);
  });

  it("false explícito desliga", async () => {
    const linha = bancoCom({
      prospeccao: { vendedor_nome: "Ana", nao_pausar_antes_da_primeira_resposta: true },
    });

    const res = await patch({ vendedor_nome: "Ana", nao_pausar_antes_da_primeira_resposta: false });

    expect(res.status).toBe(200);
    expect(linha.settings.prospeccao).toEqual({ vendedor_nome: "Ana", nao_pausar_antes_da_primeira_resposta: false });
  });
});
