/**
 * #4847, ajuste 2 — os DIAS DA JANELA no cartão saem traduzidos.
 *
 * O formulário da janela já traduzia (os sete rótulos em `t()` com literal);
 * o texto do cartão (`janelaEmTexto`) montava "Seg, Ter" direto do português,
 * e uma campanha em espanhol mostrava dia da semana em português misturado com
 * "Funciona solo en". Este arquivo prova os dois lados: em espanhol o cartão
 * mostra `Lun, Mar, Mié, Jue, Vie`, e em português continua `Seg, Ter, …`.
 *
 * A prova é por TELA (componente real + `IdiomaProvider`), não por regex do
 * fonte: o que a revisão mediu foi o que o cartão mostra, e é isso que um
 * `t(` + parâmetro (a armadilha que o commit `3791f8ca2c` já fechou no
 * formulário) voltaria a quebrar silenciosamente.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

import { ProspectingClient } from "@/app/app/prospecting/_client";

const COMPLETA = "11111111-1111-4111-8111-111111111111";
const AGENT = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PIPE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const QUALIFIED = "44444444-4444-4444-8444-444444444445";

const CONFIG = {
  agent_id: AGENT,
  channel_session_id: CHANNEL,
  pipeline_id: PIPE,
  stage_id: STAGE,
  qualified_stage_id: QUALIFIED,
  instruction: "Oferecer uma avaliação comercial.",
  qualification: "Confirmou a necessidade e quer conversar.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação real registrada pelo operador",
  ofertas: ["site"],
  funnel_entry: "on_send",
  // Seg-sex, 7h-12h — a janela do caso de uso da issue.
  janela: { dias: [1, 2, 3, 4, 5], inicio: 7, fim: 12 },
};

function fixture(locale: string | null) {
  return {
    configured: true,
    campaigns: [
      {
        id: COMPLETA,
        search: { niche: "clínica", location: "Manaus" },
        name: "Manhã — clínicas",
        status: "paused",
        search_status: "succeeded",
        error: null,
        config: CONFIG,
        result_count: 0,
        skipped_count: 0,
        cost_usd: "0.10",
        next_send_at: "2026-11-18T10:00:00Z",
        channel_session_id: CHANNEL,
        pausada_pela_janela: true,
      },
    ],
    candidates: [],
    agents: [{ id: AGENT, name: "Agente existente" }],
    personalizacao: {
      vendedor_nome: "",
      vendedor_apresentacao: "",
      vendedor_diferencial: "",
      vocabulario: {},
    },
    channels: [{ id: CHANNEL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
    stages: [],
    organization_locale: locale,
  };
}

function abrirCartao(locale: "pt-BR" | "es") {
  api.get.mockImplementation(async () => ({ data: fixture(locale) }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={client}>
        <ProspectingClient />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("o cartão da janela traduz os dias (#4847, ajuste 2)", () => {
  it("em espanhol, o cartão diz 'Funciona solo en Lun, Mar, Mié, Jue, Vie' — não 'Seg, Ter'", async () => {
    abrirCartao("es");
    fireEvent.click(await screen.findByRole("button", { name: /Manhã — clínicas/ }));
    const linha = await screen.findByText(/^Funciona solo en/);
    expect(linha.textContent).toContain("Lun, Mar, Mié, Jue, Vie");
    expect(linha.textContent).not.toMatch(/\bSeg\b|\bTer\b|\bQua\b/);
  });

  it("em português, o cartão continua 'Roda só em Seg, Ter, Qua, Qui, Sex, 7h–12h'", async () => {
    abrirCartao("pt-BR");
    fireEvent.click(await screen.findByRole("button", { name: /Manhã — clínicas/ }));
    const linha = await screen.findByText(/^Roda só em/);
    expect(linha.textContent).toContain("Seg, Ter, Qua, Qui, Sex, 7h–12h");
  });

  it("o botão novo do cartão fala pelo t(): em espanhol é 'Pausar contactos', não 'Pausar abordagens'", async () => {
    // A4 (#4847): o botão que a campanha pausada pela JANELA ganhou passa por
    // `t()` com o texto literal. O cartão em espanhol não pode mostrar o
    // português — a chave do dicionário existe, e o teste é o que a mantém
    // ligada ao botão (um texto solto no JSX ficaria em português).
    abrirCartao("es");
    fireEvent.click(await screen.findByRole("button", { name: /Manhã — clínicas/ }));
    expect(await screen.findByRole("button", { name: "Pausar contactos" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Pausar abordagens" })).toBeNull();
  });
});
