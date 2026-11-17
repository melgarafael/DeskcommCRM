import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * O ARQUIVO DA PRIMEIRA ABORDAGEM NA TELA DA CAMPANHA (#4751).
 *
 * A mídia da abordagem (#4581) só se configurava pela API: quem atualizou e
 * procurou na tela não achou. Aqui a prova é pelo que o "Iniciar" GRAVA: escolher
 * um arquivo põe `midia_da_abordagem` na configuração enviada, e remover tira a
 * chave — a campanha volta a sair só com texto. A lista oferece só o que a régua
 * do envio aceita: o áudio de uma resposta rápida não aparece.
 */

const AGENTE = "55555555-5555-4555-8555-555555555555";
const CANAL = "22222222-2222-4222-8222-222222222222";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const CAMPANHA = "11111111-1111-4111-8111-111111111111";
const ORG = "0b110000-0000-4000-8000-000000000001";

const IMAGEM = {
  storage_path: `${ORG}/templates/t1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: 320_000,
};
const AUDIO = {
  storage_path: `${ORG}/templates/t1/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.ogg`,
  media_mime: "audio/ogg",
  media_size_bytes: 90_000,
};

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

const ESTADO = {
  configured: true,
  organization_locale: "pt-BR",
  campaigns: [
    {
      id: CAMPANHA,
      name: "Clínicas A",
      status: "draft",
      search_status: "succeeded",
      error: null,
      search: { niche: "estetica", city: "Sorocaba" },
      config: null,
      result_count: 1,
      skipped_count: 0,
      cost_usd: "0.10",
      next_send_at: null,
    },
  ],
  candidates: [
    {
      id: "cand-1",
      campaign_id: CAMPANHA,
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
    },
  ],
  agents: [{ id: AGENTE, name: "Agente" }],
  channels: [{ id: CANAL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
  stages: [{ id: ETAPA, name: "Novos", pipeline_id: FUNIL, pipeline_name: "Comercial" }],
};

function abrir() {
  api.get.mockImplementation(async (caminho: string) =>
    caminho.startsWith("/api/v1/message-templates")
      ? { data: [{ id: "t1", title: "Boas-vindas", midias: [IMAGEM, AUDIO] }] }
      : { data: ESTADO },
  );
  api.post.mockResolvedValue({ data: {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}

async function formulario() {
  fireEvent.click(await screen.findByRole("button", { name: /Clínicas A/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Entregar agente" }));
  await screen.findByRole("region", { name: "Agente selecionado" });
}

const campo = () => screen.getByLabelText("Arquivo da primeira abordagem");

/** O `config` que o "Iniciar" mandou para a API, como sai no fio (JSON). */
async function configGravada() {
  fireEvent.submit(
    screen.getByRole("button", { name: "Iniciar abordagens com IA" }).closest("form")!,
  );
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  const corpo = api.post.mock.calls.at(-1)![1] as { action: string; config: Record<string, unknown> };
  expect(corpo.action).toBe("start");
  return JSON.parse(JSON.stringify(corpo.config)) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("arquivo da primeira abordagem na configuração da campanha", () => {
  it("o campo diz os tipos e tamanhos aceitos e oferece só o que a abordagem aceita", async () => {
    abrir();
    await formulario();
    expect(screen.getByText(/Aceita imagem \(JPG, PNG ou WEBP, até 5 MB\), vídeo/)).toBeInTheDocument();
    await waitFor(() => expect(within(campo()).getAllByRole("option")).toHaveLength(2));
    expect(within(campo()).queryByRole("option", { name: /Áudio|ogg/ })).toBeNull();
  });

  it("escolher um arquivo grava a mídia na configuração, com o aviso de risco", async () => {
    abrir();
    await formulario();
    await waitFor(() => expect(within(campo()).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(campo(), { target: { value: IMAGEM.storage_path } });
    expect(screen.getByRole("note")).toHaveTextContent("no máximo 30 abordagens por dia");
    expect((await configGravada()).midia_da_abordagem).toEqual(IMAGEM);
  });

  it("remover tira a mídia da configuração: a campanha sai só com texto", async () => {
    abrir();
    await formulario();
    await waitFor(() => expect(within(campo()).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(campo(), { target: { value: IMAGEM.storage_path } });
    fireEvent.click(screen.getByRole("button", { name: "Remover arquivo" }));
    expect(campo()).toHaveValue("");
    expect(screen.queryByRole("note")).toBeNull();
    expect(await configGravada()).not.toHaveProperty("midia_da_abordagem");
  });
});
