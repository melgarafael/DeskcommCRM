// app/app/leads/[id]/pagina/rota-da-pagina-do-negocio.test.tsx
/**
 * #4151 — a PÁGINA INTEIRA do negócio (`/app/leads/<id>/pagina`).
 *
 * O link estável `/app/leads/<id>` continua redirecionando para o quadro com o
 * painel (teste vizinho, `../rota-estavel-do-negocio.test.tsx`). Esta rota é o
 * caminho próprio da página, alcançado pelo botão Expandir, e ela RENDERIZA.
 * O que este arquivo guarda:
 *
 *  - o controle de OUTRA organização (a consulta é filtrada pela org ativa; sem a
 *    linha da org, `notFound()` — nunca renderizar o negócio de outra org);
 *  - negócio sem funil também é `notFound()` (sem funil não há etapa, nem
 *    campos, nem o que a página desenha);
 *  - a linha entregue ao componente cliente passa pela MESMA projeção das rotas
 *    irmãs (`ocultarProvaMetaNaResposta`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireAuthMock,
  resolveActiveOrgMock,
  notFoundMock,
  redirectMock,
  eqMock,
  orderMock,
  limitMock,
  maybeSingleMock,
  paginaMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  notFoundMock: vi.fn(),
  redirectMock: vi.fn(),
  eqMock: vi.fn(),
  orderMock: vi.fn(),
  limitMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  paginaMock: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/leads/l-1/pagina",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));

/**
 * O encadeamento do supabase-js: `select().eq().eq().order().limit().maybeSingle()`.
 * Uma corrente só, devolvendo a si mesma — o que muda é o que cada `maybeSingle`
 * da fila responde (lead, funil, score, conversa).
 */
const corrente = {
  eq: eqMock,
  order: orderMock,
  limit: limitMock,
  maybeSingle: maybeSingleMock,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => corrente }),
  }),
}));

// A página inteira é client e carrega os blocos do dossiê: aqui o objeto é a
// ROTA (quem ela acha, o que ela entrega), não o desenho.
vi.mock("./_pagina", () => ({ PaginaDoNegocio: paginaMock }));

import { CHAVE_PROVA_NASCIMENTO_META } from "@/lib/leads/prova-meta-lead-submitted";

import LeadPage from "./page";

afterEach(() => vi.clearAllMocks());

function prepararSessao() {
  // `mockReset` (e não `clear`) também descarta a FILA de `mockResolvedValueOnce`
  // do teste anterior: uma sobra de duas linhas desalinha a leitura do lado e o
  // teste mede a linha errada.
  maybeSingleMock.mockReset();
  eqMock.mockReset();
  orderMock.mockReset();
  limitMock.mockReset();
  requireAuthMock.mockResolvedValue({ id: "u-1" });
  resolveActiveOrgMock.mockResolvedValue({ orgId: "org-1", role: "admin" });
  eqMock.mockReturnValue(corrente);
  orderMock.mockReturnValue(corrente);
  limitMock.mockReturnValue(corrente);
  // No Next, `notFound()` LANÇA — a execução para ali. Um mock silencioso
  // deixaria a página seguir e o teste mediria o mock.
  notFoundMock.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
}

describe("#4151 — a rota da página inteira do negócio RENDERIZA", () => {
  it("monta a página do negócio em vez de redirecionar para o quadro", async () => {
    prepararSessao();
    maybeSingleMock
      .mockResolvedValueOnce({ data: { id: "l-1", title: "Viagem Rio", pipeline_id: "p-1" } })
      .mockResolvedValueOnce({ data: { id: "p-1", name: "Comercial", settings: {} } })
      .mockResolvedValueOnce({ data: null });

    const el = (await LeadPage({ params: Promise.resolve({ id: "l-1" }) })) as unknown as {
      type: unknown;
      props: { lead: { id: string; title: string }; voltarHref: string };
    };

    expect(redirectMock).not.toHaveBeenCalled();
    expect(notFoundMock).not.toHaveBeenCalled();
    // A página do negócio é o que a rota DEVOLVE — aqui não há `redirect`.
    expect(el.type).toBe(paginaMock);
    expect(el.props.lead.id).toBe("l-1");
    expect(el.props.lead.title).toBe("Viagem Rio");
    // Sem `?voltar=` (link direto), o voltar é o quadro DESTE negócio.
    expect(el.props.voltarHref).toBe("/app/pipelines/p-1");
  });

  it("o `?voltar=` do quadro de origem chega à página, e é validado", async () => {
    prepararSessao();
    maybeSingleMock
      .mockResolvedValueOnce({ data: { id: "l-1", title: "Viagem Rio", pipeline_id: "p-1" } })
      .mockResolvedValueOnce({ data: { id: "p-1", name: "Comercial", settings: {} } })
      .mockResolvedValueOnce({ data: null });

    const el = (await LeadPage({
      params: Promise.resolve({ id: "l-1" }),
      searchParams: Promise.resolve({ voltar: "/app/pipelines/p-1?tag=quente" }),
    })) as unknown as { props: { voltarHref: string } };

    expect(el.props.voltarHref).toBe("/app/pipelines/p-1?tag=quente");
  });

  it("a linha entregue ao componente cliente não leva a prova interna de `source_metadata`", async () => {
    prepararSessao();
    maybeSingleMock
      .mockResolvedValueOnce({
        data: {
          id: "l-1",
          title: "Viagem Rio",
          pipeline_id: "p-1",
          source_metadata: { campanha: "ads", [CHAVE_PROVA_NASCIMENTO_META]: { interno: true } },
        },
      })
      .mockResolvedValueOnce({ data: { id: "p-1", name: "Comercial", settings: {} } })
      .mockResolvedValueOnce({ data: null });

    const el = (await LeadPage({ params: Promise.resolve({ id: "l-1" }) })) as unknown as {
      props: { lead: { source_metadata: Record<string, unknown> } };
    };

    // O que é comercial fica; a chave interna não atravessa para o navegador.
    expect(el.props.lead.source_metadata).toEqual({ campanha: "ads" });
    expect(JSON.stringify(el.props)).not.toContain(CHAVE_PROVA_NASCIMENTO_META);
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
    maybeSingleMock
      .mockResolvedValueOnce({ data: { id: "l-2", title: "Sem funil", pipeline_id: null } })
      // A consulta do funil com `id: null` não acha linha — que é o caso real.
      .mockResolvedValueOnce({ data: null });

    await expect(LeadPage({ params: Promise.resolve({ id: "l-2" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    expect(notFoundMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
