import { describe, expect, it, vi } from "vitest";

const { funilDoNumeroMock } = vi.hoisted(() => ({ funilDoNumeroMock: vi.fn() }));
vi.mock("./nascimento-do-lead", () => ({ funilDoNumero: funilDoNumeroMock }));

import { entradasDoAgente } from "./entrada-dos-numeros-do-agente";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const AGENTE = "22222222-2222-4222-8222-222222222222";
const FUNIL_B = "33333333-3333-4333-8333-333333333333";

type Linhas = Record<string, unknown[]>;

/** PostgREST de mentira: a cadeia termina no `await`, e cada tabela devolve as suas linhas. */
function banco(linhas: Linhas) {
  const filtrosPorTabela: Record<string, Record<string, unknown>> = {};
  return {
    filtrosPorTabela,
    db: {
      from(tabela: string) {
        const filtros: Record<string, unknown> = {};
        filtrosPorTabela[tabela] = filtros;
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => ((filtros[c] = v), q),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: linhas[tabela] ?? [], error: null }).then(resolve),
        };
        return q;
      },
    } as never,
  };
}

describe("entradasDoAgente (#4940)", () => {
  it("usa a régua do nascimento do lead para cada número vivo (nulo = funil padrão)", async () => {
    funilDoNumeroMock.mockReset();
    funilDoNumeroMock.mockImplementation(async (_db: unknown, _org: string, id: string) =>
      id === "n1" ? { pipelineId: FUNIL_B, stageId: "e1" } : null,
    );
    const { db } = banco({});
    const r = await entradasDoAgente(db, ORG, AGENTE, [{ id: "n1" }, { id: "n2" }]);
    expect(r.funilDeEntradaPorNumero).toEqual({ n1: FUNIL_B, n2: null });
    expect(funilDoNumeroMock).toHaveBeenCalledWith(db, ORG, "n1");
  });

  it("junta os números de TODOS os roteadores ativos em que ele é membro ou reserva, só os vivos", async () => {
    funilDoNumeroMock.mockReset();
    funilDoNumeroMock.mockResolvedValue(null);
    const { db, filtrosPorTabela } = banco({
      ai_router_members: [
        { ai_routers: { channel_session_id: "r1", organization_id: ORG, is_active: true } },
        { ai_routers: { channel_session_id: "r2", organization_id: ORG, is_active: true } },
        { ai_routers: { channel_session_id: "parado", organization_id: ORG, is_active: false } },
        { ai_routers: { channel_session_id: "alheio", organization_id: OUTRA_ORG, is_active: true } },
        { ai_routers: { channel_session_id: "arquivado", organization_id: ORG, is_active: true } },
        { ai_routers: null },
      ],
      ai_routers: [{ channel_session_id: "reserva" }, { channel_session_id: "r1" }],
    });
    const vivos = ["r1", "r2", "parado", "alheio", "reserva"].map((id) => ({ id }));
    const r = await entradasDoAgente(db, ORG, AGENTE, vivos);
    expect(r.numerosDoRoteador.sort()).toEqual(["r1", "r2", "reserva"]);
    expect(filtrosPorTabela.ai_routers).toMatchObject({ fallback_agent_id: AGENTE, is_active: true, organization_id: ORG });
    expect(filtrosPorTabela.ai_router_members).toMatchObject({ agent_id: AGENTE, organization_id: ORG });
  });
});
