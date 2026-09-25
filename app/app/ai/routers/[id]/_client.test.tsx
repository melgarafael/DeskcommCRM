/**
 * B1 (parte 2) da revisão do #1573: o seletor "Fluxo de atendimento" da
 * intenção aparecia com o módulo DESLIGADO — amarrar a um roteiro que a
 * instalação não roda.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authMock, flowsMock } = vi.hoisted(() => ({ authMock: vi.fn(), flowsMock: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: authMock, usePermission: () => true }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({ useFollowupFlows: flowsMock }));
vi.mock("@/hooks/ai/useRouters", () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useRouter: () => ({ data: undefined }),
    useUpdateRouter: mut,
    useDeleteRouter: mut,
    useSaveMembers: mut,
    useTestRouter: mut,
  };
});

import { RouterEditorClient } from "./_client";

afterEach(cleanup);

function renderizar() {
  return render(
    <RouterEditorClient
      routerId="r1"
      initialState={{
        router: {
          id: "r1",
          name: "Roteador",
          channel_session_id: "s1",
          is_active: true,
          config: {},
          fallback_agent_id: null,
        },
        members: [
          {
            id: "m1",
            agent_id: "a1",
            intent_name: "financiamento",
            intent_description: "quer financiar",
            examples: [],
            position: 0,
            flow_pointer_id: null,
          } as never,
        ],
      }}
      agents={[{ id: "a1", name: "Agente" }]}
      channelSessions={[]}
      classifierModels={[]}
    />,
  );
}

describe("seletor de roteiro na intenção × módulo", () => {
  it("desligado: o seletor não aparece e a lista de roteiros nem é buscada", () => {
    authMock.mockReturnValue({ activeOrg: { modulos_ligados: [] } });
    flowsMock.mockReturnValue({ data: undefined });
    renderizar();
    // Controle positivo: a intenção foi desenhada.
    expect(screen.getByDisplayValue("financiamento")).toBeTruthy();
    expect(screen.queryByTestId("seletor-de-roteiro")).toBeNull();
    expect(flowsMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("ligado: o seletor aparece", () => {
    authMock.mockReturnValue({ activeOrg: { modulos_ligados: ["fluxos_atendimento"] } });
    flowsMock.mockReturnValue({ data: [{ id: "f1", name: "Cadastro" }] });
    renderizar();
    expect(screen.getByTestId("seletor-de-roteiro")).toBeTruthy();
  });
});
