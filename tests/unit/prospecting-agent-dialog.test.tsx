import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { ProspectingClient } from "@/app/app/prospecting/_client";
import { ApiError } from "@/lib/api/types";
import type { AgentSessionResponse } from "@/lib/prospecting/agent-session-schema";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const OTHER_CAMPAIGN = "11111111-1111-4111-8111-111111111112";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const QUALIFIED = "44444444-4444-4444-8444-444444444445";
const AGENT = "55555555-5555-4555-8555-555555555555";
const NEW_AGENT = "55555555-5555-4555-8555-555555555556";
const CONFIG = {
  agent_id: AGENT,
  channel_session_id: CHANNEL,
  pipeline_id: PIPELINE,
  stage_id: STAGE,
  qualified_stage_id: QUALIFIED,
  instruction: "Oferecer uma avaliação comercial.",
  qualification: "Confirmou a necessidade e quer conversar.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação real registrada pelo operador",
};
function fixture() {
  const campaigns = [
    {
      id: CAMPAIGN,
      name: "Clínicas de estética",
      status: "draft",
      search_status: "succeeded",
      error: null,
      config: null as typeof CONFIG | null,
      result_count: 1,
      skipped_count: 0,
      cost_usd: "0.10",
      next_send_at: "2026-09-16T00:00:00Z",
    },
    {
      id: OTHER_CAMPAIGN,
      name: "Escritórios de contabilidade",
      status: "draft",
      search_status: "succeeded",
      error: null,
      config: null as typeof CONFIG | null,
      result_count: 1,
      skipped_count: 0,
      cost_usd: "0.10",
      next_send_at: "2026-09-16T00:00:00Z",
    },
  ];
  return {
    configured: true,
    campaigns,
    candidates: campaigns.map((campaign, index) => ({
      id: `candidate-${index}`,
      campaign_id: campaign.id,
      progress: "new",
      message_status: null,
      error: null,
      conversation_id: null,
      data: {
        name: "Empresa de teste",
        category: "Serviços",
        phone: null,
        address: null,
        website: null,
        rating: null,
        reviews: 0,
        emails: [],
        socials: [],
      },
    })),
    agents: [{ id: AGENT, name: "Agente existente" }],
    channels: [{ id: CHANNEL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
    stages: [
      { id: STAGE, name: "Novos", pipeline_id: PIPELINE, pipeline_name: "Comercial" },
      { id: QUALIFIED, name: "Qualificados", pipeline_id: PIPELINE, pipeline_name: "Comercial" },
    ],
  };
}
let state: ReturnType<typeof fixture>;
const sessions = new Map<string, AgentSessionResponse>();
const CHAT = "/api/v1/prospecting/agents/chat";
const CREATE = "/api/v1/prospecting/agents";
const PREPARE = `${CREATE}/prepare`;
const SESSION = `${CREATE}/session`;
const VERSION = "66666666-6666-4666-8666-666666666666";
let chatReply: typeof api.post;
let createReply: typeof api.post;
let prepareReply: typeof api.post;
let testReply: typeof api.post;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function openPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}
function current(id = CAMPAIGN) {
  if (!sessions.has(id))
    sessions.set(id, {
      revision: 0,
      session: {
        messages: [],
        draft: {
          name: state.campaigns.find((campaign) => campaign.id === id)!.name,
          tone: "cordial",
        },
        input: "",
        ready: false,
        choices: [],
        model_label: "",
        needs_continuity: false,
        enable_router_continuity: false,
        uncertain: false,
      },
    });
  return sessions.get(id)!;
}
function proposal(overrides = {}) {
  return {
    message: "Preparei as instruções. Confira o resumo e teste quando estiver pronto.",
    draft: {
      name: "Clara",
      tone: "cordial" as const,
      instruction: CONFIG.instruction,
      qualification: CONFIG.qualification,
      channel_session_id: CHANNEL,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      qualified_stage_id: QUALIFIED,
    },
    ready: true,
    choices: [],
    model_label: "IA configurada",
    needs_continuity: false,
    ...overrides,
  };
}
function created() {
  return {
    agent: { id: NEW_AGENT, name: "Clara" },
    version_id: VERSION,
    model_label: "IA configurada",
  };
}
async function builder() {
  return screen.findByRole("region", { name: "Configuração por conversa" });
}
async function say(content: string) {
  await builder();
  fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
    target: { value: content },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
}
async function ready() {
  return screen.findByRole("button", { name: "Publicar e usar agente" });
}
const mutationCalls = () => api.post.mock.calls.filter(([url]) => url === CREATE);
beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  state = fixture();
  chatReply = vi.fn(async () => proposal());
  createReply = vi.fn(async () => created());
  prepareReply = vi.fn(async () => created());
  testReply = vi.fn(async () => ({
    status: "completed",
    final_text: "Qual é o principal desafio da sua clínica hoje?",
    guardrails: {
      passou: true,
      termos: [],
      naoAvaliados: [{ gate: "delivery", porque: "O canal não é acionado no teste." }],
    },
  }));
  api.get.mockImplementation(async (url: string) => ({
    data: url.startsWith(SESSION)
      ? clone(current(new URL(url, "https://crm.test").searchParams.get("campaign_id")!))
      : state,
  }));
  api.patch.mockImplementation(async (_url, body) => {
    const saved = current(body.campaign_id);
    if (body.revision !== saved.revision)
      throw new ApiError(
        409,
        "session_conflict",
        undefined,
        "r1",
        "A conversa mudou em outra aba.",
      );
    saved.revision++;
    saved.session = { ...saved.session, ...clone(body.session) };
    if (!body.session.attempt) {
      delete saved.session.attempt;
      delete saved.session.attempt_action;
      delete saved.session.prepared;
    }
    return { data: clone(saved) };
  });
  api.post.mockImplementation(async (url, body, options) => {
    if (url === CHAT) {
      const saved = current(body.campaign_id);
      saved.revision++;
      saved.session.messages = clone(body.messages);
      saved.session.input = "";
      const response = await chatReply(body, options);
      saved.revision++;
      saved.session = {
        ...saved.session,
        ...response,
        messages: [...saved.session.messages, { role: "assistant", content: response.message }],
        input: "",
        uncertain: false,
      };
      return { data: { ...response, ...clone(saved) } };
    }
    if (url === PREPARE) {
      const result = await prepareReply(body);
      const saved = current(body.campaign_id);
      saved.session.prepared = result;
      saved.session.uncertain = false;
      return { data: result };
    }
    if (url === CREATE) {
      const result = await createReply(body);
      const saved = current(body.campaign_id);
      saved.session.completed = result;
      saved.session.uncertain = false;
      return { data: result };
    }
    if (url.endsWith("/test")) return { data: await testReply(body, options) };
    return { data: {} };
  });
});
afterEach(cleanup);

describe("conversa principal para configurar o agente", () => {
  it("começa na conversa com resumo incompleto e sugestões, sem criar ou iniciar nada", async () => {
    openPage();
    await builder();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Resumo do agente" })).toHaveTextContent(
      "0 de 6 definições preenchidas",
    );
    expect(screen.getByRole("button", { name: "Qualificar interessados" })).toBeVisible();
    expect(screen.queryByLabelText("Agente de IA")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Iniciar abordagens com IA" }),
    ).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("conversa, exige continuidade explícita e publica sem iniciar a campanha", async () => {
    chatReply.mockResolvedValue(proposal({ needs_continuity: true }));
    openPage();
    await say("Quero qualificar clínicas que precisam de automação.");
    const publish = await ready();
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Manter a continuidade/ }));
    fireEvent.click(publish);
    await screen.findByRole("region", { name: "Agente selecionado" });
    expect(mutationCalls()[0]![1]).toMatchObject({
      campaign_id: CAMPAIGN,
      enable_router_continuity: true,
      name: "Clara",
    });
    expect(screen.getByRole("link", { name: "Configurar assistente de voz" })).toHaveAttribute(
      "href",
      `/app/ai/agents/${NEW_AGENT}#voice-assistant`,
    );
    expect(screen.getByLabelText("Máximo em 24 horas")).toHaveValue(10);
    expect(screen.getByLabelText("Referência da avaliação de legítimo interesse")).toHaveValue("");
    expect(api.post.mock.calls.some(([, body]) => body.action === "start")).toBe(false);
  });

  it("testa o rascunho pausado no runtime canônico e só publica por outro comando", async () => {
    openPage();
    await say("Montar um agente para oferecer avaliação comercial.");
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Testar como cliente" }));
    fireEvent.change(screen.getByLabelText("Mensagem do cliente para o teste"), {
      target: { value: "Tenho interesse, como funciona?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Testar resposta" }));
    await screen.findByText("Qual é o principal desafio da sua clínica hoje?");
    expect(api.post.mock.calls.some(([url]) => url === PREPARE)).toBe(true);
    expect(api.post).toHaveBeenCalledWith(
      `/api/v1/ai/agents/${NEW_AGENT}/versions/${VERSION}/test`,
      { sample_message: "Tenho interesse, como funciona?" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mutationCalls()).toHaveLength(0);
    expect(screen.getByText("O canal não é acionado no teste.")).toBeInTheDocument();
    const attempt = current().session.attempt;
    fireEvent.click(screen.getByRole("button", { name: "Configurar conversando" }));
    await say("Mude a abordagem para perguntar sobre agendamento.");
    await ready();
    expect(current().session.attempt).toBeUndefined();
    expect(current().session.prepared).toBeUndefined();
    expect(attempt?.request_id).toBeTruthy();
    expect(
      screen.queryByText("Qual é o principal desafio da sua clínica hoje?"),
    ).not.toBeInTheDocument();
  });

  it("guarda o texto digitado e a conversa no CRM para recarregar a página", async () => {
    const view = openPage();
    await say("Quero vender para clínicas.");
    await ready();
    fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
      target: { value: "Quero ajustar a qualificação" },
    });
    await waitFor(() => expect(current().session.input).toBe("Quero ajustar a qualificação"));
    view.unmount();
    openPage();
    await builder();
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toHaveValue(
      "Quero ajustar a qualificação",
    );
    expect(
      within(screen.getByRole("log")).getByText("Quero vender para clínicas."),
    ).toBeInTheDocument();
  });

  it("troca campanhas preservando até o texto ainda aguardando autosave", async () => {
    openPage();
    await builder();
    fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
      target: { value: "Oferta só para clínicas" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Escritórios de contabilidade/ }));
    await builder();
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toHaveValue("");
    await waitFor(() => expect(current().session.input).toBe("Oferta só para clínicas"));
    fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
      target: { value: "Oferta para contadores" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Clínicas de estética/ }));
    await builder();
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toHaveValue(
      "Oferta só para clínicas",
    );
    await waitFor(() =>
      expect(current(OTHER_CAMPAIGN).session.input).toBe("Oferta para contadores"),
    );
  });

  it("cancelamento preserva a mensagem para repetir sem apresentar uma resposta tardia", async () => {
    chatReply.mockImplementationOnce(
      (_body, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    openPage();
    await say("Quero configurar um atendimento comercial.");
    await waitFor(() => expect(chatReply).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar resposta" }));
    await screen.findByText(
      "Resposta interrompida. Sua mensagem foi mantida para tentar novamente.",
    );
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toHaveValue(
      "Quero configurar um atendimento comercial.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await ready();
    expect(
      within(screen.getByRole("log")).getAllByText("Quero configurar um atendimento comercial."),
    ).toHaveLength(1);
  });

  it("falha de ajuste invalida a publicação anterior e repete o turno sem duplicar", async () => {
    chatReply
      .mockResolvedValueOnce(proposal())
      .mockRejectedValueOnce(new Error("A IA demorou para responder."))
      .mockResolvedValueOnce(proposal());
    openPage();
    await say("Criar um agente para oferecer avaliação comercial");
    await ready();
    await say("Mude para um atendimento curto e direto.");
    await screen.findByText("A IA demorou para responder.");
    expect(
      screen.queryByRole("button", { name: "Publicar e usar agente" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await ready();
    expect(chatReply.mock.calls[1]![0].messages).toEqual(chatReply.mock.calls[2]![0].messages);
    expect(
      within(screen.getByRole("log")).getAllByText("Mude para um atendimento curto e direto."),
    ).toHaveLength(1);
  });

  it("recupera uma publicação sem resposta após reload usando a tentativa já salva", async () => {
    createReply
      .mockRejectedValueOnce(new Error("Conexão interrompida."))
      .mockResolvedValueOnce(created());
    const view = openPage();
    await say("Criar agente para empresas encontradas.");
    fireEvent.click(await ready());
    await screen.findByText("Conexão interrompida.");
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toBeDisabled();
    const attempt = clone(mutationCalls()[0]![1]);
    expect(current().session.attempt).toEqual(attempt);
    expect(current().session.attempt_action).toBe("publish");
    view.unmount();
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: "Recuperar criação do agente" }));
    await screen.findByRole("region", { name: "Agente selecionado" });
    expect(mutationCalls()[1]![1]).toEqual(attempt);
  });

  it("recupera preparação sem resposta após reload sem transformar o teste em publicação", async () => {
    chatReply.mockResolvedValue(proposal({ needs_continuity: true }));
    prepareReply
      .mockRejectedValueOnce(new Error("Não recebemos a confirmação do rascunho."))
      .mockResolvedValueOnce(created());
    const view = openPage();
    await say("Criar um agente que qualifique clínicas.");
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Testar como cliente" }));
    fireEvent.change(screen.getByLabelText("Mensagem do cliente para o teste"), {
      target: { value: "Como funciona?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Testar resposta" }));
    await screen.findByText("Não recebemos a confirmação do rascunho.");
    expect(current().session.attempt_action).toBe("prepare");
    expect(current().session.uncertain).toBe(true);
    const attempt = clone(current().session.attempt);
    view.unmount();
    openPage();
    const recover = await screen.findByRole("button", { name: "Recuperar rascunho de teste" });
    expect(recover).toBeEnabled();
    fireEvent.click(recover);
    await screen.findByText(
      "Rascunho salvo e pausado. Você pode testar e ajustar antes de publicar.",
    );
    expect(prepareReply.mock.calls[1]![0]).toEqual(attempt);
    expect(mutationCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Publicar e usar agente" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Manter a continuidade/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publicar e usar agente" }));
    await screen.findByRole("region", { name: "Agente selecionado" });
    expect(mutationCalls()[0]![1]).toMatchObject({
      request_id: attempt!.request_id,
      enable_router_continuity: true,
    });
    expect(current().session.attempt_action).toBe("publish");
  });

  it("recusa conhecida permite ajustar a proposta e gerar outra tentativa", async () => {
    createReply
      .mockRejectedValueOnce(
        new ApiError(422, "validation_failed", undefined, "r1", "Escolha outro canal."),
      )
      .mockResolvedValueOnce(created());
    openPage();
    await say("Criar agente comercial");
    fireEvent.click(await ready());
    await screen.findByText("Escolha outro canal.");
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toBeEnabled();
    chatReply.mockResolvedValueOnce(
      proposal({
        draft: {
          ...proposal().draft,
          instruction: "Convidar para uma conversa inicial com nossa equipe.",
        },
      }),
    );
    await say("Convide para uma conversa inicial.");
    fireEvent.click(await ready());
    await screen.findByRole("region", { name: "Agente selecionado" });
    expect(mutationCalls()[0]![1].request_id).not.toEqual(mutationCalls()[1]![1].request_id);
  });

  it("conflito de gravação fica visível e bloqueia ações até recarregar a versão salva", async () => {
    openPage();
    await builder();
    current().revision++;
    fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
      target: { value: "Alteração da aba antiga" },
    });
    await screen.findByText("A conversa mudou em outra aba.");
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(current().session.input).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Recarregar conversa salva" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Mensagem para configurar o agente")).toBeEnabled(),
    );
    expect(screen.getByLabelText("Mensagem para configurar o agente")).toHaveValue("");
  });

  it("espera toda a fila de autosave antes de enviar, inclusive texto digitado durante uma gravação", async () => {
    const patch = api.patch.getMockImplementation()!;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    api.patch
      .mockImplementationOnce(async (...args) => {
        await first;
        return patch(...args);
      })
      .mockImplementationOnce(async (...args) => {
        await second;
        return patch(...args);
      });
    openPage();
    await builder();
    fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
      target: { value: "Primeiro texto" },
    });
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Mensagem para configurar o agente"), {
      target: { value: "Texto final que quero enviar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    releaseFirst();
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(api.post).not.toHaveBeenCalled();
    releaseSecond();
    await ready();
    expect(api.patch.mock.calls.map(([, body]) => body.revision)).toEqual([0, 1]);
    expect(chatReply.mock.calls[0]![0].revision).toBe(2);
    expect(chatReply.mock.calls[0]![0].messages.at(-1).content).toBe(
      "Texto final que quero enviar",
    );
    expect(screen.queryByText("A conversa mudou em outra aba.")).not.toBeInTheDocument();
  });

  it("permite interromper o teste sem publicar ou enviar a contatos", async () => {
    testReply.mockImplementationOnce(
      (_body, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    openPage();
    await say("Montar um agente de qualificação comercial.");
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Testar como cliente" }));
    fireEvent.change(screen.getByLabelText("Mensagem do cliente para o teste"), {
      target: { value: "Pode me ajudar?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Testar resposta" }));
    await waitFor(() => expect(testReply).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Parar de esperar" }));
    await screen.findByText(
      "A espera foi interrompida. O teste já enviado pode continuar no provedor.",
    );
    expect(screen.getByRole("button", { name: "Testar resposta" })).toBeEnabled();
    expect(mutationCalls()).toHaveLength(0);
    expect(current().session.prepared?.agent.id).toBe(NEW_AGENT);
  });

  it("uma publicação já concluída volta selecionada após recarregar", async () => {
    const saved = current();
    saved.session = {
      ...saved.session,
      ...proposal(),
      completed: created(),
      attempt: {
        ...proposal().draft,
        tone: "cordial",
        request_id: "77777777-7777-4777-8777-777777777777",
        campaign_id: CAMPAIGN,
        enable_router_continuity: false,
      },
    };
    openPage();
    await screen.findByRole("region", { name: "Agente selecionado" });
    expect(screen.getByRole("link", { name: "Configurações avançadas do agente" })).toHaveAttribute(
      "href",
      `/app/ai/agents/${NEW_AGENT}`,
    );
    expect(mutationCalls()).toHaveLength(0);
  });

  it("opções sugeridas respondem no chat sem criar o agente", async () => {
    chatReply.mockResolvedValueOnce(
      proposal({
        ready: false,
        choices: [{ label: "Usar Comercial", value: "Quero o canal Comercial" }],
      }),
    );
    openPage();
    await say("Quero um agente para qualificar clínicas.");
    fireEvent.click(await screen.findByRole("button", { name: "Usar Comercial" }));
    await ready();
    expect(chatReply.mock.calls[1]![0].messages.at(-1)).toEqual({
      role: "user",
      content: "Quero o canal Comercial",
    });
    expect(mutationCalls()).toHaveLength(0);
  });
});

describe("alternativa manual e campanha existente", () => {
  it("mantém controles manuais como alternativa e preserva dados por campanha", async () => {
    openPage();
    await builder();
    fireEvent.click(
      screen.getByRole("button", { name: "Usar agente existente / configurar manualmente" }),
    );
    const offer = () => screen.getByLabelText("O que a IA deve oferecer e como iniciar");
    fireEvent.change(offer(), { target: { value: "Oferecer avaliação para clínicas" } });
    fireEvent.click(screen.getByRole("button", { name: /Escritórios de contabilidade/ }));
    await builder();
    fireEvent.click(
      screen.getByRole("button", { name: "Usar agente existente / configurar manualmente" }),
    );
    expect(offer()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /Clínicas de estética/ }));
    expect(offer()).toHaveValue("Oferecer avaliação para clínicas");
    fireEvent.click(screen.getByRole("button", { name: "Configurar por conversa" }));
    await say("Complete o agente com essa oferta.");
    await ready();
    expect(chatReply.mock.calls[0]![0].draft.instruction).toBe("Oferecer avaliação para clínicas");
  });
  it("preserva a configuração congelada de uma campanha que já preparou contatos", async () => {
    state.campaigns[0]!.config = CONFIG;
    openPage();
    const select = await screen.findByLabelText("Agente de IA");
    expect(select).toHaveValue(AGENT);
    expect(select).toBeDisabled();
    expect(
      screen.queryByRole("region", { name: "Configuração por conversa" }),
    ).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
