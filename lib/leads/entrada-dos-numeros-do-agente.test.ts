import { describe, expect, it, vi } from "vitest";

const { funilDoNumeroMock } = vi.hoisted(() => ({ funilDoNumeroMock: vi.fn() }));
vi.mock("./nascimento-do-lead", () => ({ funilDoNumero: funilDoNumeroMock }));

import { entradasDoAgente } from "./entrada-dos-numeros-do-agente";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENTE = "22222222-2222-4222-8222-222222222222";
const OUTRO = "77777777-7777-4777-8777-777777777777";
const FUNIL_B = "33333333-3333-4333-8333-333333333333";

type Resposta = { data: unknown[] | null; error: unknown };

/** PostgREST de mentira: a cadeia termina no `await`, e cada tabela devolve a sua resposta. */
function banco(respostas: Record<string, Resposta>) {
  const filtros: Record<string, Record<string, unknown>> = {};
  return {
    filtros,
    db: {
      from(tabela: string) {
        const f: Record<string, unknown> = {};
        filtros[tabela] = f;
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => ((f[c] = v), q),
          in: (c: string, v: unknown) => ((f[c] = v), q),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(respostas[tabela] ?? { data: [], error: null }).then(resolve),
        };
        return q;
      },
    } as never,
  };
}

describe("entradasDoAgente (#4940)", () => {
  it("só roda a régua do nascimento do lead para quem escolheu funil; os outros ficam no padrão", async () => {
    funilDoNumeroMock.mockReset();
    funilDoNumeroMock.mockResolvedValue({ pipelineId: FUNIL_B, stageId: "e1" });
    const { db, filtros } = banco({
      channel_sessions: {
        data: [
          { id: "n1", entry_pipeline_id: FUNIL_B },
          { id: "n2", entry_pipeline_id: null },
        ],
        error: null,
      },
    });
    const r = await entradasDoAgente(db, ORG, AGENTE, [{ id: "n1" }, { id: "n2" }]);
    expect(r.funilDeEntradaPorNumero).toEqual({ n1: FUNIL_B, n2: null });
    expect(funilDoNumeroMock).toHaveBeenCalledTimes(1);
    expect(funilDoNumeroMock).toHaveBeenCalledWith(db, ORG, "n1");
    expect(filtros.channel_sessions).toMatchObject({ organization_id: ORG, id: ["n1", "n2"] });
  });

  it("funil escolhido que a régua do lead recusa (sem etapa aberta, arquivado) fica no padrão", async () => {
    funilDoNumeroMock.mockReset();
    funilDoNumeroMock.mockResolvedValue(null);
    const { db } = banco({
      channel_sessions: { data: [{ id: "n1", entry_pipeline_id: FUNIL_B }], error: null },
    });
    const r = await entradasDoAgente(db, ORG, AGENTE, [{ id: "n1" }]);
    expect(r.funilDeEntradaPorNumero).toEqual({ n1: null });
  });

  it("banco sem a coluna (leitura falhou): todo número no padrão, sem quebrar a página", async () => {
    funilDoNumeroMock.mockReset();
    const { db } = banco({ channel_sessions: { data: null, error: { code: "42703" } } });
    const r = await entradasDoAgente(db, ORG, AGENTE, [{ id: "n1" }]);
    expect(r.funilDeEntradaPorNumero).toEqual({ n1: null });
    expect(funilDoNumeroMock).not.toHaveBeenCalled();
  });

  it("números dos roteadores ativos que levam conversa a ele, pela régua do turno", async () => {
    funilDoNumeroMock.mockReset();
    const { db, filtros } = banco({
      ai_routers: {
        data: [
          // membro, sem regras de remetente: entra
          { id: "ra", channel_session_id: "a", fallback_agent_id: OUTRO, config: {} },
          // reserva: entra
          { id: "rb", channel_session_id: "b", fallback_agent_id: AGENTE, config: {} },
          // membro, mas o roteador tem regras de remetente que não o citam: membros não entram
          {
            id: "rc",
            channel_session_id: "c",
            fallback_agent_id: OUTRO,
            config: { sender_routes: [{ phone: "1", agent_id: OUTRO }] },
          },
          // não é membro, mas uma regra de remetente o cita: entra
          {
            id: "rd",
            channel_session_id: "d",
            fallback_agent_id: OUTRO,
            config: { sender_routes: [{ phone: "2", agent_id: AGENTE }] },
          },
          // número arquivado (fora da lista viva): não entra
          { id: "re", channel_session_id: "arquivado", fallback_agent_id: AGENTE, config: {} },
        ],
        error: null,
      },
      ai_router_members: { data: [{ router_id: "ra" }, { router_id: "rc" }], error: null },
    });
    const r = await entradasDoAgente(
      db,
      ORG,
      AGENTE,
      ["a", "b", "c", "d"].map((id) => ({ id })),
    );
    expect(r.numerosDoRoteador.sort()).toEqual(["a", "b", "d"]);
    expect(filtros.ai_routers).toMatchObject({ organization_id: ORG, is_active: true });
    expect(filtros.ai_router_members).toMatchObject({ organization_id: ORG, agent_id: AGENTE });
  });
});
