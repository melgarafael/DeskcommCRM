/**
 * #2415 — o destino de funil/etapa não persistia após salvar e recarregar:
 * o SELECT server-side do editor (o page.tsx que monta o initialState do SSR)
 * não trazia pipeline_id/stage_id. A API de detalhe já trazia; o PUT já
 * gravava; faltava a carga inicial enxergar os campos.
 *
 * #4340 (segunda metade) — o editor também recebe, do servidor, os números
 * para onde este roteador PODE ir: vivos e sem roteador nenhum. A régua é a
 * mesma da lista; aqui se prova que o SSR a aplica (e que o número já roteado
 * não vira destino).
 */
import { describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, createClientMock, canaisMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
  canaisMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/ai/classifier-models", () => ({ listClassifierModels: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: canaisMock }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("./_client", () => ({ RouterEditorClient: () => null }));

import RouterEditorPage from "./page";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";

/**
 * `listSelectableChannels` já filtra `archived_at`: o número ANTIGO (s1) não
 * vem. s2 tem roteador; s3 é o único destino possível.
 */
const CANAIS = [
  { id: "s2", display_name: "Do outro roteador", phone_number: null, status: "WORKING", provider: "evolution" },
  { id: "s3", display_name: "Livre", phone_number: null, status: "WORKING", provider: "evolution" },
];

/**
 * PostgREST falso de UM cliente: `select` guarda as colunas, e a cadeia é
 * thenable para o `await` que o page.tsx faz na consulta da lista.
 */
function clienteFalso(selects: Record<string, string>) {
  return {
    from(tabela: string) {
      let colunas = "";
      const q = {
        select(c: string) {
          colunas = c;
          selects[tabela] = c;
          return q;
        },
        eq: () => q,
        is: () => q,
        order: () => Promise.resolve(dados(tabela, colunas)),
        maybeSingle: () => Promise.resolve(dados(tabela, colunas)),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(dados(tabela, colunas)).then(resolve),
      };
      return q;
    },
  };
}

function dados(tabela: string, colunas: string): { data: unknown; error: null } {
  if (tabela === "ai_routers") {
    if (colunas.trim() === "channel_session_id") {
      // O número s2 já pertence a outro roteador.
      return { data: [{ channel_session_id: "s2" }], error: null };
    }
    return {
      data: {
        id: ROUTER_ID,
        name: "Roteador",
        channel_session_id: "s1",
        is_active: true,
        config: {},
        fallback_agent_id: null,
      },
      error: null,
    };
  }
  return { data: [], error: null };
}

describe("SELECT server-side do editor do roteador (#2415)", () => {
  it("os membros são selecionados com pipeline_id e stage_id", async () => {
    requireAuthMock.mockResolvedValue({ is_platform_admin: true, support: false });
    resolveActiveOrgMock.mockResolvedValue({ orgId: ORG_ID, role: "admin" });
    canaisMock.mockResolvedValue(CANAIS);

    const selects: Record<string, string> = {};
    createClientMock.mockReturnValue(clienteFalso(selects));

    const el = await RouterEditorPage({ params: Promise.resolve({ id: ROUTER_ID }) });
    expect(el).toBeTruthy();
    expect(selects.ai_router_members).toContain("pipeline_id");
    expect(selects.ai_router_members).toContain("stage_id");
  });
});

describe("#4340 — o SSR entrega os destinos possíveis da mudança de número", () => {
  it("só número vivo e SEM roteador é oferecido; o antigo e o já roteado ficam fora", async () => {
    requireAuthMock.mockResolvedValue({ is_platform_admin: true, support: false });
    resolveActiveOrgMock.mockResolvedValue({ orgId: ORG_ID, role: "admin" });
    canaisMock.mockResolvedValue(CANAIS);
    createClientMock.mockReturnValue(clienteFalso({}));

    const el = await RouterEditorPage({ params: Promise.resolve({ id: ROUTER_ID }) });

    // O elemento criado, não um render: page.tsx é server component.
    const props = (el as { props: { children: { props: Record<string, unknown> } } }).props.children
      .props;
    expect(props.numeroRemovido, "s1 não está entre os oferecíveis").toBe(true);
    expect(props.numerosLivres).toEqual([{ id: "s3", rotulo: "Livre" }]);
  });
});
