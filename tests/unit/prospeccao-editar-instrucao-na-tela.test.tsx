import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * EDITAR A INSTRUÇÃO E OS CRITÉRIOS PELA TELA — issue #4570.
 *
 * Com a campanha pausada a tela oferecia só "Editar ritmo" e "Retomar fila": o
 * texto que a IA lê e os critérios de qualificação ficavam congelados no início,
 * e corrigir uma palavra custava criar outra campanha. Aqui se prova o caminho
 * da pessoa: o botão existe só na campanha pausada, o formulário nasce com o
 * texto gravado, e nada é enviado antes da confirmação — porque o texto novo
 * vale para as próximas abordagens.
 */

const AGENTE = "55555555-5555-4555-8555-555555555555";
const CANAL = "22222222-2222-4222-8222-222222222222";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const CAMPANHA = "11111111-1111-4111-8111-111111111111";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/app/app/prospecting/_create-agent", () => ({
  ProspectingAgentBuilder: () => <div />,
}));

import { ProspectingClient } from "@/app/app/prospecting/_client";

const INSTRUCAO = "Apresente o serviço para clínicas da região e peça permissão para seguir.";
const CRITERIO = "Confirmar se a clínica recebe agendamentos pelo WhatsApp todos os dias.";

const CONFIG = {
  agent_id: AGENTE,
  channel_session_id: CANAL,
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  qualified_stage_id: ETAPA,
  instruction: INSTRUCAO,
  qualification: CRITERIO,
  ofertas: ["site"],
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "legítimo interesse, registro 1",
};

function abrir(status: "paused" | "running") {
  api.get.mockResolvedValue({
    data: {
      configured: true,
      organization_locale: "pt-BR",
      campaigns: [
        {
          id: CAMPANHA,
          name: "Clínicas de Sorocaba",
          status,
          channel_session_id: CANAL,
          search_status: "succeeded",
          error: null,
          search: { niche: "clinicas", city: "Sorocaba" },
          config: CONFIG,
          result_count: 0,
          skipped_count: 0,
          cost_usd: "0.10",
          next_send_at: null,
        },
      ],
      candidates: [],
      agents: [{ id: AGENTE, name: "Agente" }],
      channels: [{ id: CANAL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
      stages: [{ id: ETAPA, name: "Novos", pipeline_id: FUNIL, pipeline_name: "Comercial" }],
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}

const botaoEditar = () => screen.queryByRole("button", { name: "Editar instrução e critérios" });

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("o botão só existe com a campanha pausada", () => {
  it("pausada: 'Editar instrução e critérios' aparece ao lado de 'Editar ritmo'", async () => {
    abrir("paused");
    expect(await screen.findByRole("button", { name: "Editar ritmo" })).toBeInTheDocument();
    expect(botaoEditar()).toBeInTheDocument();
  });

  it("rodando: a tela não oferece editar o texto — só pausar", async () => {
    abrir("running");
    expect(await screen.findByRole("button", { name: "Pausar abordagens" })).toBeInTheDocument();
    expect(botaoEditar()).toBeNull();
  });
});

describe("o formulário nasce com o texto gravado e só salva depois de confirmar", () => {
  it("mostra instrução e critérios atuais, e não chama a API no primeiro clique", async () => {
    abrir("paused");
    fireEvent.click(await screen.findByRole("button", { name: "Editar instrução e critérios" }));
    expect(screen.getByDisplayValue(INSTRUCAO)).toBeInTheDocument();
    expect(screen.getByDisplayValue(CRITERIO)).toBeInTheDocument();
    // Doc 358 › 1A: a tela diz a quem o texto novo vale — e a quem não vale.
    expect(
      screen.getByText(/Vale só para as empresas que ainda não foram abordadas/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Salvar instrução e critérios" }));
    // A confirmação existe porque o texto vale para as próximas abordagens.
    expect(
      screen.getByText(/Confirmar a troca do texto desta campanha/),
    ).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("confirmar envia edit_briefing com o texto novo", async () => {
    abrir("paused");
    fireEvent.click(await screen.findByRole("button", { name: "Editar instrução e critérios" }));
    fireEvent.change(screen.getByDisplayValue(INSTRUCAO), {
      target: { value: "Ofereça a auditoria do site e proponha uma conversa de 15 minutos." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar instrução e critérios" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar alteração" }));

    expect(api.post).toHaveBeenCalledWith("/api/v1/prospecting", {
      action: "edit_briefing",
      id: CAMPANHA,
      instruction: "Ofereça a auditoria do site e proponha uma conversa de 15 minutos.",
      qualification: CRITERIO,
      ofertas: ["site"],
      // #4829: o interruptor da ficha digital está no mesmo formulário e vai junto —
      // a config desta campanha não tem a chave, e ausente = ligada.
      usar_ficha_digital: true,
    });
    expect(await screen.findByText("Instrução e critérios atualizados. A campanha continua pausada."))
      .toBeInTheDocument();
  });

  // #4829: o formulário é o único lugar que religa/desliga a ficha digital com a campanha
  // pausada. Se o `false` não chegasse na API, o interruptor seria só estado de tela.
  it("desligar a ficha digital no formulário manda `usar_ficha_digital: false`", async () => {
    abrir("paused");
    fireEvent.click(await screen.findByRole("button", { name: "Editar instrução e critérios" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Usar a ficha digital/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar instrução e critérios" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar alteração" }));

    expect(api.post).toHaveBeenCalledWith("/api/v1/prospecting", {
      action: "edit_briefing",
      id: CAMPANHA,
      instruction: INSTRUCAO,
      qualification: CRITERIO,
      ofertas: ["site"],
      usar_ficha_digital: false,
    });
  });

  it("texto abaixo do piso não deixa salvar — o servidor recusaria com 422", async () => {
    abrir("paused");
    fireEvent.click(await screen.findByRole("button", { name: "Editar instrução e critérios" }));
    fireEvent.change(screen.getByDisplayValue(INSTRUCAO), { target: { value: "ok" } });
    expect(screen.getByRole("button", { name: "Salvar instrução e critérios" })).toBeDisabled();
  });

  it("cancelar fecha o formulário sem chamar a API", async () => {
    abrir("paused");
    fireEvent.click(await screen.findByRole("button", { name: "Editar instrução e critérios" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByDisplayValue(INSTRUCAO)).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
