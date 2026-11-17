import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * A PRÉVIA DA SAÍDA MOSTRA O QUE SAI — revisão do #4416 (#4370).
 *
 * O rádio "Na primeira mensagem" cita a frase que a abertura leva. Com
 * `config.texto_da_saida` preenchido e válido, o worker envia o texto do dono
 * (`comSaida(..., cfg.texto_da_saida)`); a prévia seguia citando a frase padrão.
 * A régua aqui é a mesma do envio: `textoDaSaidaEfetivo`.
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
  ProspectingAgentBuilder: (props: {
    campaign: { id: string };
    onCreated: (id: string, agente: unknown, setup: unknown) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void props.onCreated(
          props.campaign.id,
          { agent: { id: AGENTE, name: "Agente" }, model_label: "m" },
          {
            channel_session_id: CANAL,
            pipeline_id: FUNIL,
            stage_id: ETAPA,
            qualified_stage_id: ETAPA,
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
import { rodapeDeSaida } from "@/lib/prospecting/rodape-de-saida";

function abrir() {
  api.get.mockResolvedValue({
    data: {
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
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}

const PREFIXO = "A abertura já diz como parar:";

/** A frase citada depois do prefixo, no texto renderizado da dica. */
function fraseDaPrevia(): string {
  const dica = screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent!.startsWith(PREFIXO));
  return dica.textContent!.slice(PREFIXO.length).trim();
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("a prévia do rádio 'Na primeira mensagem' cita o texto que o envio leva", () => {
  it("campo vazio: a frase padrão; texto próprio válido: o texto do dono", async () => {
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: /Clínicas A/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Entregar agente" }));
    await screen.findByRole("region", { name: "Agente selecionado" });

    expect(fraseDaPrevia()).toBe(rodapeDeSaida("pt-BR"));

    const proprio = "Se não fizer sentido agora, responda PARAR e eu não insisto.";
    fireEvent.change(screen.getByLabelText("Texto da opção de parar"), {
      target: { value: proprio },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fraseDaPrevia()).toBe(proprio);
  });
});
