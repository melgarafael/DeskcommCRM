import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * O CAMPO DE ETIQUETAS NA TELA DA CAMPANHA — revisão do #3468.
 *
 * O Iniciar é travado por etiqueta com problema, e o aviso que explica a trava mora no campo.
 * Enquanto o campo ficava só no modo manual, quem usava "Configurar por conversa" (o padrão)
 * recebia o botão desligado sem nenhum aviso. O construtor de agente é trocado por um botão:
 * o que importa aqui é o estado da tela depois de ele entregar o agente.
 */

const AGENTE = "55555555-5555-4555-8555-555555555555";
const CANAL = "22222222-2222-4222-8222-222222222222";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const CAMPANHA_A = "11111111-1111-4111-8111-111111111111";
const CAMPANHA_B = "11111111-1111-4111-8111-222222222222";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/app/app/prospecting/_create-agent", () => ({
  ProspectingAgentBuilder: (props: {
    campaign: { id: string };
    onCreated: (id: string, agente: unknown, setup: unknown) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void props.onCreated(
          props.campaign.id,
          { agent: { id: "55555555-5555-4555-8555-555555555555", name: "Agente" }, model_label: "m" },
          {
            channel_session_id: "22222222-2222-4222-8222-222222222222",
            pipeline_id: "33333333-3333-4333-8333-333333333333",
            stage_id: "44444444-4444-4444-8444-444444444444",
            qualified_stage_id: "44444444-4444-4444-8444-444444444444",
            instruction: "Oferecer uma avaliação comercial.",
            qualification: "Confirmou a necessidade.",
          },
        )
      }
    >
      Entregar agente
    </button>
  ),
}));

import { ProspectingClient } from "@/app/app/prospecting/_client";

const campanha = (id: string, name: string, niche: string) => ({
  id,
  name,
  status: "draft",
  search_status: "succeeded",
  error: null,
  search: { niche, city: "Sorocaba" },
  config: null,
  result_count: 1,
  skipped_count: 0,
  cost_usd: "0.10",
  next_send_at: null,
});

function abrir(...campanhas: ReturnType<typeof campanha>[]) {
  api.get.mockResolvedValue({
    data: {
      configured: true,
      organization_locale: "pt-BR",
      campaigns: campanhas,
      // A etapa 2 só aparece com empresas na lista.
      candidates: campanhas.map((c) => ({
        id: `cand-${c.id}`,
        campaign_id: c.id,
        progress: "new",
        message_status: null,
        error: null,
        conversation_id: null,
        data: {
          name: "Empresa",
          phone: "+5511999990000",
          website: null,
          category: "Serviços",
          address: "Rua X",
          maps_url: null,
          rating: 4.8,
          reviews: 120,
          emails: [],
          socials: [],
        },
      })),
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

/** Do modo padrão até o formulário: abre a campanha e recebe o agente pela conversa. */
async function formularioPorConversa(nome: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(nome) }));
  fireEvent.click(await screen.findByRole("button", { name: "Entregar agente" }));
  await screen.findByRole("region", { name: "Agente selecionado" });
}

const campo = () => screen.getByLabelText("Etiquetas do contato");
const iniciar = () => screen.getByRole("button", { name: "Iniciar abordagens com IA" });
const aviso = () => screen.queryByRole("alert");

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("em 'Configurar por conversa' o operador vê o que vai ser gravado", () => {
  it("o campo aparece preenchido com o nicho que cabe, e o Iniciar segue ligado", async () => {
    abrir(campanha(CAMPANHA_A, "Clínicas A", "estetica, odonto"));
    await formularioPorConversa("Clínicas A");
    expect(campo()).toHaveValue("estetica, odonto");
    expect(iniciar()).toBeEnabled();
  });

  it("etiqueta a mais segura o Iniciar COM o aviso visível, e apagar destrava", async () => {
    abrir(campanha(CAMPANHA_A, "Clínicas A", "estetica"));
    await formularioPorConversa("Clínicas A");
    fireEvent.change(campo(), { target: { value: "a, b, c, d, e, f" } });
    expect(iniciar()).toBeDisabled();
    expect(aviso()).toHaveTextContent("São no máximo 5 etiquetas");
    fireEvent.change(campo(), { target: { value: "a, b, c, d, e" } });
    expect(iniciar()).toBeEnabled();
    expect(aviso()).toBeNull();
  });
});

describe("o nicho que não cabe nunca trava nem encurta", () => {
  it.each([
    ["mais de 40 caracteres", "clinicas de estetica e harmonizacao facial em sorocaba"],
    ["seis partes", "estetica, odonto, dermato, harmonizacao, botox, pilates"],
  ])("%s: campo vazio, sem aviso e Iniciar ligado", async (_caso, nicho) => {
    abrir(campanha(CAMPANHA_A, "Clínicas A", nicho));
    await formularioPorConversa("Clínicas A");
    expect(campo()).toHaveValue("");
    expect(aviso()).toBeNull();
    expect(iniciar()).toBeEnabled();
  });
});

describe("o texto digitado é da campanha, não da tela", () => {
  it("digitar demais em A, ir para B e voltar: o texto e o aviso de A continuam lá", async () => {
    abrir(campanha(CAMPANHA_A, "Clínicas A", "estetica"), campanha(CAMPANHA_B, "Clínicas B", "odonto"));
    await formularioPorConversa("Clínicas A");
    const longa = "x".repeat(41);
    fireEvent.change(campo(), { target: { value: longa } });
    expect(aviso()).toHaveTextContent("até 40 caracteres");

    await formularioPorConversa("Clínicas B");
    fireEvent.change(campo(), { target: { value: "odonto, vip" } });
    expect(aviso()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Clínicas A/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("até 40 caracteres");
    expect(campo()).toHaveValue(longa);
    expect(iniciar()).toBeDisabled();
  });
});
