import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * O AVISO DA MÍDIA NA TELA DA CAMPANHA (#4581, decisão do dono em 15/11, doc 358 › 2A).
 *
 * O mesmo arquivo indo para muitos números frios aumenta o risco de bloqueio do
 * WhatsApp. Quem configurou a mídia precisa ler isso na campanha, em palavras de
 * leigo, junto do teto que o envio aplica — e quem não configurou não lê nada.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { ProspectingClient } from "@/app/app/prospecting/_client";
import { TETO_DIARIO_DE_MIDIA_POR_NUMERO } from "@/lib/prospecting/midia-da-abordagem";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

const MIDIA = {
  storage_path: `${CAMPAIGN}/templates/a/b.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: 320_000,
};

function abrir(comMidia: boolean) {
  api.get.mockResolvedValue({
    data: {
      configured: true,
      organization_locale: "pt-BR",
      campaigns: [
        {
          id: CAMPAIGN,
          name: "Clínicas de estética",
          status: "paused",
          search_status: "succeeded",
          error: null,
          config: {
            agent_id: AGENT,
            channel_session_id: CHANNEL,
            pipeline_id: PIPELINE,
            stage_id: STAGE,
            qualified_stage_id: STAGE,
            instruction: "Oferecer uma avaliação comercial.",
            qualification: "Confirmou a necessidade.",
            daily_limit: 10,
            interval_minutes: 15,
            legal_basis_ref: "Avaliação registrada",
            ...(comMidia ? { midia_da_abordagem: MIDIA } : {}),
          },
          result_count: 1,
          skipped_count: 0,
          cost_usd: "0.10",
          next_send_at: "2026-11-15T00:00:00Z",
        },
      ],
      candidates: [],
      agents: [{ id: AGENT, name: "Agente" }],
      channels: [{ id: CHANNEL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
      stages: [{ id: STAGE, name: "Novos", pipeline_id: PIPELINE, pipeline_name: "Comercial" }],
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("campanha com mídia: a tela avisa do risco e do teto", () => {
  it("o aviso diz, em palavras simples, o risco de bloqueio e o teto diário por número", async () => {
    abrir(true);
    const aviso = await screen.findByText(/esta campanha manda o mesmo arquivo/);
    expect(aviso).toHaveTextContent("aumenta o risco de o WhatsApp bloquear o seu número");
    expect(aviso).toHaveTextContent(
      `no máximo ${TETO_DIARIO_DE_MIDIA_POR_NUMERO} abordagens por dia`,
    );
    expect(aviso).toHaveTextContent("saem só com o texto");
    expect(aviso).not.toHaveTextContent("{teto}");
  });
});

describe("campanha sem mídia: nenhum aviso", () => {
  it("a tela não fala de arquivo que a campanha não manda", async () => {
    abrir(false);
    await screen.findByText(/abordagens em 24 horas/);
    expect(screen.queryByText(/esta campanha manda o mesmo arquivo/)).toBeNull();
  });
});
