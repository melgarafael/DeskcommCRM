/**
 * B1 (parte 2) da revisão do #1573: o seletor "Fluxo de atendimento" da
 * intenção aparecia com o módulo DESLIGADO — amarrar a um roteiro que a
 * instalação não roda.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authMock, flowsMock, testeMock, updateMock, pipelinesMock, stagesMock, routerDataMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  flowsMock: vi.fn(),
  // O tipo de retorno explícito evita que o tsc infira `undefined` do default
  // e reprove os mockReturnValue de teste (#2415).
  pipelinesMock: vi.fn((): { data: unknown } => ({ data: undefined })),
  stagesMock: vi.fn((): { data: unknown } => ({ data: undefined })),
  testeMock: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, data: undefined as unknown })),
  updateMock: vi.fn(async () => ({})),
  // #2415 — o que o React Query devolve no refetch: undefined = sem query em cache.
  routerDataMock: vi.fn((): { data: unknown } => ({ data: undefined })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: authMock, usePermission: () => true }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({ useFollowupFlows: flowsMock }));
// #2155 — o seletor de funil/etapa de destino usa os MESMOS hooks dos webhooks:
// sem o mock, a renderização estoura "No QueryClient set" (não há provider aqui).
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  usePipelines: pipelinesMock,
  usePipelineStages: stagesMock,
}));
vi.mock("@/hooks/ai/useRouters", () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useRouter: () => routerDataMock(),
    useUpdateRouter: () => ({ mutate: vi.fn(), mutateAsync: updateMock, isPending: false }),
    useDeleteRouter: mut,
    useSaveMembers: mut,
    useTestRouter: testeMock,
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

describe("tamanho do contexto do roteador", () => {
  it("roteador legado mostra quatro mensagens e salva oito quando o admin escolhe", async () => {
    authMock.mockReturnValue({ activeOrg: { modulos_ligados: [] } });
    flowsMock.mockReturnValue({ data: undefined });
    updateMock.mockClear();
    renderizar();
    const campo = screen.getByLabelText("Mensagens anteriores para o roteamento");
    expect(campo).toHaveValue(4);
    fireEvent.change(campo, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ context_message_count: 8 }) }));
  });
});

describe("Testar classificação com o Jev (onda 2 do Jev, bloco 2.2)", () => {
  const RESULTADO = {
    intent_name: "financiamento",
    confidence: 0.82,
    min_confidence: 0.6,
    agent_id: "a1",
    agent_name: "Agente Financiamento",
  };
  const DO_JEV = {
    estado: "observando" as const,
    respondeu: true,
    intent_name: "suporte",
    confidence: 0.91,
    agent_id: "a2",
    agent_name: "Agente Suporte",
    decide: false,
  };

  function comResultado(data: unknown) {
    authMock.mockReturnValue({ activeOrg: { modulos_ligados: [] } });
    flowsMock.mockReturnValue({ data: undefined });
    testeMock.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, data });
    renderizar();
  }

  it("Jev desligado: a tela é a de sempre, sem o lado dele", () => {
    comResultado({ ...RESULTADO, jev: null });
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Financiamento");
    expect(screen.queryByTestId("teste-com-o-jev")).toBeNull();
  });

  it("observando: as duas escolhas lado a lado, e quem atende é o da sua IA", () => {
    comResultado({ ...RESULTADO, jev: DO_JEV });
    expect(screen.getByTestId("teste-escolha-da-ia").textContent).toContain("Agente Financiamento");
    expect(screen.getByTestId("teste-escolha-da-ia").textContent).toContain("82%");
    expect(screen.getByTestId("teste-escolha-do-jev").textContent).toContain("Agente Suporte");
    expect(screen.getByTestId("teste-escolha-do-jev").textContent).toContain("suporte · 91%");
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Financiamento");
    expect(screen.getByTestId("teste-quem-decide").textContent).toMatch(/só observa/);
  });

  it("decidindo: quem atende é o escolhido pelo Jev", () => {
    comResultado({ ...RESULTADO, jev: { ...DO_JEV, estado: "decidindo", decide: true } });
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Suporte");
    expect(screen.getByTestId("teste-quem-decide").textContent).toMatch(/vale a escolha dele/);
  });

  it("sob demanda distingue a reserva dispensada de falha de resposta", () => {
    comResultado({ ...RESULTADO, confidence: null, ia_consultada: false, modo_roteador: "sob_demanda", jev: { ...DO_JEV, estado: "decidindo", decide: true } });
    expect(screen.getByTestId("teste-escolha-da-ia").textContent).toContain("Não foi necessário consultar");
    expect(screen.getByTestId("teste-quem-decide").textContent).toContain("O Jev decidiu sozinho");
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Suporte");
  });

  it("sob demanda explica reserva por baixa confiança mesmo quando Jev respondeu", () => {
    comResultado({ ...RESULTADO, ia_consultada: true, modo_roteador: "sob_demanda", jev: { ...DO_JEV, confidence: 0.3, estado: "decidindo", decide: false } });
    expect(screen.getByTestId("teste-quem-decide").textContent).toContain("O Jev precisou de reserva");
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Financiamento");
  });

  it("decidindo sem a sua IA (R2): quem atende NÃO é o do Jev", () => {
    comResultado({
      ...RESULTADO,
      intent_name: null,
      confidence: null,
      agent_id: null,
      agent_name: null,
      jev: { ...DO_JEV, estado: "decidindo", decide: false },
    });
    expect(screen.getByTestId("teste-escolha-da-ia").textContent).toContain("não respondeu");
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).not.toContain("Agente Suporte");
    expect(screen.getByTestId("teste-quem-decide").textContent).toMatch(/nunca só o Jev/);
  });

  /**
   * O bloco de cima lia a intenção e a confiança da IA e o agente do Jev: com a
   * IA abaixo do mínimo, dizia "cairia no atendimento padrão em produção" com o
   * agente do Jev logo abaixo. Decidindo, ele lê inteiro o lado que vale.
   */
  it("decidindo: o resultado de cima é todo do Jev — a IA abaixo do mínimo não diz que cairia no padrão", () => {
    comResultado({ ...RESULTADO, confidence: 0.4, jev: { ...DO_JEV, estado: "decidindo", decide: true } });
    const resultado = screen.getByTestId("teste-resultado");
    expect(resultado.textContent).not.toMatch(/cairia no atendimento padrão/);
    expect(resultado.textContent).toContain("Intenção: suporte");
    expect(resultado.textContent).toContain("91%");
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Suporte");

    // Controle: o Jev abaixo do mínimo é quem cairia no padrão.
    cleanup();
    comResultado({ ...RESULTADO, jev: { ...DO_JEV, confidence: 0.3, estado: "decidindo", decide: true } });
    expect(screen.getByTestId("teste-resultado").textContent).toMatch(/30% — abaixo do mínimo de 60%/);
  });

  it("decidindo, e nem a sua IA nem o Jev responderam: vale a regra de sempre, e não 'a sua IA decidiria'", () => {
    comResultado({
      ...RESULTADO,
      intent_name: null,
      confidence: null,
      agent_id: null,
      agent_name: null,
      jev: {
        ...DO_JEV,
        estado: "decidindo",
        decide: false,
        respondeu: false,
        intent_name: null,
        confidence: null,
        agent_id: null,
        agent_name: null,
      },
    });
    const quemDecide = screen.getByTestId("teste-quem-decide").textContent;
    expect(quemDecide).toMatch(/nunca só o Jev/);
    expect(quemDecide).not.toMatch(/a sua IA decidiria/);
  });

  it("decidindo, a sua IA respondeu e o Jev não: em produção, a sua IA decide no lugar dele", () => {
    comResultado({
      ...RESULTADO,
      jev: { ...DO_JEV, estado: "decidindo", decide: false, respondeu: false, intent_name: null, confidence: null, agent_id: null, agent_name: null },
    });
    expect(screen.getByTestId("teste-quem-decide").textContent).toMatch(/a sua IA decidiria no lugar dele/);
    expect(screen.getByTestId("teste-agente-que-atenderia").textContent).toBe("Agente Financiamento");
  });

  /**
   * Observando, com a sua IA sem responder (o cenário do e2e no CI, de chave
   * falsa): a tela dizia "vale a escolha da sua IA" logo abaixo de "Sua IA
   * escolheu: não respondeu".
   */
  it("observando, e a sua IA não respondeu: vale a regra de sempre, e não 'a escolha da sua IA'", () => {
    comResultado({ ...RESULTADO, intent_name: null, confidence: null, agent_id: "a9", agent_name: "Agente Reserva", jev: DO_JEV });
    const quemDecide = screen.getByTestId("teste-quem-decide").textContent;
    expect(quemDecide).toMatch(/só observa/);
    expect(quemDecide).toMatch(/regra de sempre/);
    expect(quemDecide).not.toMatch(/vale a escolha da sua IA/);
  });

  it("a escolha da sua IA abaixo do mínimo leva a marca, como a do Jev", () => {
    comResultado({ ...RESULTADO, confidence: 0.42, jev: { ...DO_JEV, estado: "decidindo", decide: true } });
    expect(screen.getByTestId("teste-escolha-da-ia").textContent).toMatch(/42% — abaixo do mínimo/);
  });

  it("ligado e sem resposta: o lado dele diz que não respondeu, sem número inventado", () => {
    comResultado({
      ...RESULTADO,
      jev: { ...DO_JEV, respondeu: false, intent_name: null, confidence: null, agent_id: null, agent_name: null },
    });
    expect(screen.getByTestId("teste-escolha-do-jev").textContent).toContain("não respondeu");
    expect(screen.getByTestId("teste-escolha-do-jev").textContent).not.toContain("%");
    // E leva ao motivo, que mora no cartão dele.
    expect(within(screen.getByTestId("teste-escolha-do-jev")).getByRole("link", { name: "Ver o motivo no cartão do Jev" })).toHaveAttribute(
      "href",
      "/app/ai/providers",
    );
  });
});

/**
 * #2415 — o destino de funil/etapa não persistia após salvar e recarregar: o
 * SSR chegava sem pipeline_id/stage_id e o draft não reidratava quando o
 * React Query devolvia a resposta completa da API.
 */
describe("destino do funil/etapa do roteador (#2415)", () => {
  const ROTEADOR = {
    id: "r1",
    name: "Roteador",
    channel_session_id: "s1",
    is_active: true,
    config: {},
    fallback_agent_id: null,
  };
  // O SSR legado chegava SEM os campos de destino (o defeito da issue).
  const MEMBRO_SEM_DESTINO = {
    id: "m1",
    agent_id: "a1",
    intent_name: "financiamento",
    intent_description: "quer financiar",
    examples: [],
    position: 0,
    flow_pointer_id: null,
  } as never;
  // A resposta completa da API de detalhe (já selecionava os dois campos).
  const MEMBRO_COM_DESTINO = {
    id: "m1",
    agent_id: "a1",
    intent_name: "financiamento",
    intent_description: "quer financiar",
    examples: [],
    position: 0,
    flow_pointer_id: null,
    pipeline_id: "p1",
    stage_id: "e1",
  } as never;

  function elemento() {
    return (
      <RouterEditorClient
        routerId="r1"
        initialState={{ router: ROTEADOR, members: [MEMBRO_SEM_DESTINO] }}
        agents={[{ id: "a1", name: "Agente" }]}
        channelSessions={[]}
        classifierModels={[]}
      />
    );
  }

  function comFunisDoOrgao() {
    routerDataMock.mockReturnValue({ data: undefined });
    authMock.mockReturnValue({ activeOrg: { modulos_ligados: [] } });
    flowsMock.mockReturnValue({ data: undefined });
    pipelinesMock.mockReturnValue({ data: { data: [{ id: "p1", name: "Funil Vendas" }] } });
    stagesMock.mockReturnValue({ data: { data: { stages: [{ id: "e1", name: "Prospecção" }] } } });
  }

  it("o refetch com a resposta completa da API reidrata o destino no draft", () => {
    comFunisDoOrgao();
    const { rerender } = render(elemento());
    // Controle negativo: o SSR legado nasce sem destino.
    expect(screen.getByRole("combobox", { name: "Funil de destino (opcional)" })).toHaveTextContent(
      "Sem destino — só escolher o agente",
    );
    // O refetch chega com pipeline_id + stage_id (o que a API devolve).
    routerDataMock.mockReturnValue({ data: { router: ROTEADOR, members: [MEMBRO_COM_DESTINO] } });
    rerender(elemento());
    expect(screen.getByRole("combobox", { name: "Funil de destino (opcional)" })).toHaveTextContent("Funil Vendas");
    expect(screen.getByRole("combobox", { name: "Etapa de destino" })).toHaveTextContent("Prospecção");
  });

  it("refetch não sobrescreve edição local pendente", () => {
    comFunisDoOrgao();
    const { rerender } = render(elemento());
    fireEvent.change(screen.getByDisplayValue("financiamento"), { target: { value: "financiamento novo" } });
    routerDataMock.mockReturnValue({ data: { router: ROTEADOR, members: [MEMBRO_COM_DESTINO] } });
    rerender(elemento());
    // A edição local fica; o destino continua vazio porque o refetch não pode
    // apagar o que a pessoa acabou de digitar.
    expect(screen.getByDisplayValue("financiamento novo")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Funil de destino (opcional)" })).toHaveTextContent(
      "Sem destino — só escolher o agente",
    );
  });
});
