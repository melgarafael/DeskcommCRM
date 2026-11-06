// app/app/leads/[id]/rota-estavel-do-negocio.test.tsx
/**
 * #3062 — a URL estável do negócio (`/app/leads/<id>`) é quem resolve funil +
 * card, e é para cá que Configurações › Conversões passou a apontar.
 *
 * O controle que importa aqui é o de OUTRA organização: a consulta é filtrada
 * pela organização ativa, então um link para negócio de outra org continua
 * respondendo `notFound()` — sem redirecionar para o funil de lá (o que trocaria
 * a organização ativa por baixo de quem clicou).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, notFoundMock, redirectMock, eqMock, maybeSingleMock } =
  vi.hoisted(() => ({
    requireAuthMock: vi.fn(),
    resolveActiveOrgMock: vi.fn(),
    notFoundMock: vi.fn(),
    redirectMock: vi.fn(),
    eqMock: vi.fn(),
    maybeSingleMock: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  redirect: redirectMock,
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: eqMock }) }),
  }),
}));

import LeadPage from "./page";

/** O `.eq().eq().maybeSingle()` da consulta — o mesmo objeto em toda a corrente. */
const consulta = {
  eq: eqMock,
  maybeSingle: maybeSingleMock,
};

afterEach(() => vi.clearAllMocks());

function prepararSessao() {
  requireAuthMock.mockResolvedValue({ id: "u-1" });
  resolveActiveOrgMock.mockResolvedValue({ orgId: "org-1", role: "admin" });
  eqMock.mockReturnValue(consulta);
  // No Next, `notFound()` LANÇA — a execução para ali. Um mock silencioso
  // deixaria a página seguir para o `redirect()` e o teste mediria o mock.
  notFoundMock.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
}

describe("#3062 — a rota estável do negócio", () => {
  it("redireciona para o quadro do funil COM o negócio no `?lead=`", async () => {
    prepararSessao();
    maybeSingleMock.mockResolvedValue({ data: { id: "l-1", pipeline_id: "p-1" } });

    await LeadPage({ params: Promise.resolve({ id: "l-1" }) });

    expect(redirectMock).toHaveBeenCalledWith("/app/pipelines/p-1?lead=l-1");
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("filtra pela ORGANIZAÇÃO ativa — o negócio de outra org não é encontrado", async () => {
    prepararSessao();
    // A RLS enxerga as organizações do usuário; é este filtro que separa uma da
    // outra. Sem a linha da organização ativa, a resposta é `notFound()`.
    maybeSingleMock.mockResolvedValue({ data: null });

    await expect(LeadPage({ params: Promise.resolve({ id: "l-de-outra-org" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    expect(eqMock).toHaveBeenCalledWith("organization_id", "org-1");
    expect(notFoundMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("negócio sem funil também responde `notFound()`", async () => {
    prepararSessao();
    maybeSingleMock.mockResolvedValue({ data: { id: "l-2", pipeline_id: null } });

    await expect(LeadPage({ params: Promise.resolve({ id: "l-2" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    expect(notFoundMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
