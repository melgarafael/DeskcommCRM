/**
 * #4340 — a LISTA de roteadores tem de marcar o roteador de número removido
 * como inativo e mostrar o número que ficou sem roteador.
 *
 * A tela já sabia escrever "Número removido" quando o `channel_session_id` não
 * estava entre os canais oferecíveis, mas o selo continuava "ativo" e o número
 * novo — o que recebe as conversas e cai no agente principal — não aparecia em
 * canto nenhum. Este teste mede a LEITURA do servidor: o que o `page.tsx`
 * entrega ao cliente.
 */
import { describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, createClientMock, selectableMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
  selectableMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: selectableMock }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("./_client", () => ({ RoutersClient: () => null }));

import RoutersPage from "./page";
import { lerEstadoDosRoteadores, rotuloDoNumero } from "./estado-dos-numeros";
import type { SelectableChannel } from "@/lib/channels/selectable";
import type { RouterListItem } from "@/hooks/ai/useRouters";

/** O `RoutersClient` do JSX (o componente é `null`; o que interessa são as props). */
function propsDoCliente(no: unknown): Record<string, unknown> | null {
  if (no === null || typeof no !== "object") return null;
  const elemento = no as { props?: Record<string, unknown> };
  const props = elemento.props;
  if (props && "initialState" in props) return props;
  const filhos = (props?.children ?? []) as unknown;
  for (const filho of Array.isArray(filhos) ? filhos : [filhos]) {
    const achado = propsDoCliente(filho);
    if (achado !== null) return achado;
  }
  return null;
}

const ORG = "22222222-2222-4222-8222-222222222222";
const ROTEADOR_DO_NUMERO_ANTIGO = "55555555-5555-4555-8555-555555555551";
const ROTEADOR_OK = "55555555-5555-4555-8555-555555555552";
const CANAL_ANTIGO = "44444444-4444-4444-8444-444444444441";
const CANAL_NOVO = "44444444-4444-4444-8444-444444444442";
const CANAL_COM_ROTEADOR = "44444444-4444-4444-8444-444444444443";

const ROTEADORES = [
  {
    id: ROTEADOR_DO_NUMERO_ANTIGO,
    name: "Atendimento",
    channel_session_id: CANAL_ANTIGO,
    is_active: true,
    fallback_agent_id: null,
    updated_at: "2026-10-01T00:00:00Z",
  },
  {
    id: ROTEADOR_OK,
    name: "Suporte",
    channel_session_id: CANAL_COM_ROTEADOR,
    is_active: true,
    fallback_agent_id: null,
    updated_at: "2026-10-01T00:00:00Z",
  },
];

/** O número antigo NÃO está aqui: foi arquivado. O novo está, sem roteador. */
const CANAIS = [
  {
    id: CANAL_NOVO,
    display_name: "Agendamento",
    status: "connected",
    phone_number: "5511999990000",
    aceitaMensagemLivre: true,
  },
  {
    id: CANAL_COM_ROTEADOR,
    display_name: "Suporte",
    status: "connected",
    phone_number: "5511999990001",
    aceitaMensagemLivre: true,
  },
] as unknown as SelectableChannel[];

function cadeia(resultado: unknown) {
  const q = {
    select() {
      return q;
    },
    eq() {
      return q;
    },
    is() {
      return q;
    },
    order: () => Promise.resolve({ data: resultado, error: null }),
    maybeSingle: () => Promise.resolve({ data: resultado, error: null }),
  };
  return q;
}

describe("#4340 lista de roteadores — a leitura conta o número, não só a linha", () => {
  it("o roteador do número removido sai INATIVO e o número sem roteador é listado", async () => {
    requireAuthMock.mockResolvedValue({ is_platform_admin: true, support: false, idioma: "pt-BR" });
    resolveActiveOrgMock.mockResolvedValue({ orgId: ORG, role: "admin" });
    selectableMock.mockResolvedValue(CANAIS);
    createClientMock.mockReturnValue({
      from: (tabela: string) =>
        cadeia(
          tabela === "ai_routers"
            ? ROTEADORES
            : tabela === "ai_router_members"
              ? [{ router_id: ROTEADOR_OK }]
              : [],
        ),
    });

    const props = propsDoCliente(await RoutersPage()) as unknown as {
      initialState: { routers: RouterListItem[] };
      numerosSemRoteador: Array<{ id: string; rotulo: string }>;
    };
    const porId = new Map(props.initialState.routers.map((r) => [r.id, r]));

    // O defeito: roteador apontando para número arquivado seguia "ativo".
    expect(
      porId.get(ROTEADOR_DO_NUMERO_ANTIGO)?.is_active,
      "o roteador de número removido continua parecendo ativo",
    ).toBe(false);
    // O roteador de um número que existe não é afetado.
    expect(porId.get(ROTEADOR_OK)?.is_active).toBe(true);
    // O número NOVO, sem roteador, precisa aparecer com o aviso.
    expect(props.numerosSemRoteador).toEqual([
      { id: CANAL_NOVO, rotulo: "Agendamento · 5511999990000" },
    ]);
  });

  it("a régua pura: número oferecível com roteador não vira aviso", () => {
    const estado = lerEstadoDosRoteadores(
      ROTEADORES.map((r) => ({ ...r, member_count: 0 })) as RouterListItem[],
      CANAIS,
    );

    expect(estado.numerosRemovidos).toEqual([ROTEADOR_DO_NUMERO_ANTIGO]);
    expect(estado.numerosSemRoteador.map((n) => n.id)).toEqual([CANAL_NOVO]);
    expect(estado.itens).toHaveLength(2);
  });

  it("o rótulo do número é o mesmo em qualquer tela", () => {
    expect(rotuloDoNumero({ ...CANAIS[0]!, phone_number: null })).toBe("Agendamento");
  });
});
