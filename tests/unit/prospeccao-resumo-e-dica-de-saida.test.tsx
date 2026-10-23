import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * A TELA DA CAMPANHA, NOS DOIS ACABAMENTOS QUE A PROVA PELA TELA DO PR #3091 RECUSOU.
 *
 * 1. O resumo ganhou um 5º contador ("Pediram para parar"). Numa grade de 2
 *    colunas o 5º fica sozinho na última linha, e numa de 5 colunas presa à
 *    JANELA (`md:`) o card — que em 1024px divide a tela com a lista de
 *    campanhas — espremia cada contador a 44px. Aqui se prova a aritmética
 *    da grade (nenhuma contagem de colunas deixa resto 1); a medida real
 *    (getBoundingClientRect) é da prova pela tela, porque jsdom não faz layout.
 *
 * 2. A dica "A abertura já diz como parar: …" vinha do dicionário pelo idioma
 *    da INTERFACE, mas o rodapé ENVIADO usa `organizations.locale`. Interface
 *    em espanhol numa organização pt-BR prometia "responde BAJA" e enviava
 *    "responda PARAR". A dica tem de citar a frase que sai — a mesma função,
 *    o mesmo idioma.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
// A interface está em ESPANHOL: o texto em volta segue a interface.
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (texto: string) => traduzir(texto, "es") };
});

import { ProspectingClient } from "@/app/app/prospecting/_client";
import { rodapeDeSaida } from "@/lib/prospecting/rodape-de-saida";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

function estado(organization_locale: string | null) {
  return {
    configured: true,
    organization_locale,
    campaigns: [
      {
        id: CAMPAIGN,
        name: "Clínicas de estética",
        status: "draft",
        search_status: "succeeded",
        error: null,
        // Config gravada: o formulário aparece (desabilitado), com a escolha da saída.
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
          funnel_entry: "on_send",
          exit_offer: "first_message",
        },
        result_count: 1,
        skipped_count: 0,
        cost_usd: "0.10",
        next_send_at: "2026-09-16T00:00:00Z",
      },
    ],
    candidates: [
      {
        id: "c-1",
        campaign_id: CAMPAIGN,
        progress: "sent",
        message_status: null,
        error: null,
        conversation_id: null,
        is_blocked: true,
        data: { name: "Empresa", category: "Serviços", phone: null, address: null, website: null, rating: null, reviews: 0, emails: [], socials: [] },
      },
    ],
    agents: [{ id: AGENT, name: "Agente" }],
    channels: [{ id: CHANNEL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
    stages: [{ id: STAGE, name: "Novos", pipeline_id: PIPELINE, pipeline_name: "Comercial" }],
  };
}

function abrir(organization_locale: string | null) {
  api.get.mockResolvedValue({ data: estado(organization_locale) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("o resumo da campanha não deixa contador órfão nem espremido", () => {
  it("mede o card (container), não a janela; e toda contagem de colunas fecha sem órfão", async () => {
    abrir("pt-BR");
    const grade = (await screen.findByText("Calificados")).parentElement!.parentElement!;
    const contadores = Array.from(grade.children);
    // 6 desde o "Score médio" da auditoria de site (#2711); a regra de baixo é a
    // que importa, e ela vale para qualquer contagem.
    expect(contadores).toHaveLength(6);

    // A grade responde à largura do CARD: em 1024px o card é estreito, e uma
    // regra presa à janela (md:/lg:) espremia 5 colunas nele.
    expect(grade.closest(".\\@container")).not.toBeNull();
    expect(grade.className).not.toMatch(/(^|\s)(md|lg):grid-cols-/);

    // A estrutura que garante "sem órfão": em TODA largura, N contadores em C
    // colunas deixam N % C na última linha, e 1 é o órfão. Um contador a mais,
    // ou voltar a 2 colunas, reprova aqui. col-span não conserta: o rótulo
    // fica à esquerda e o órfão continua visível (medido no #3091).
    const colunas = [...grade.className.matchAll(/(?:^|\s)(?:@?[\w-]+:)?grid-cols-(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    expect(colunas.length).toBeGreaterThan(0);
    for (const c of colunas) expect(contadores.length % c, `${c} colunas`).not.toBe(1);
    for (const c of contadores) expect(c.className).not.toMatch(/col-span/);
  });
});

describe("a dica da saída cita a frase ENVIADA, no idioma da organização", () => {
  it("interface em espanhol + organização pt-BR: a dica mostra 'responda PARAR', não BAJA", async () => {
    abrir("pt-BR");
    const dica = await screen.findByText(/La apertura ya dice cómo detenerse:/);
    // O texto em volta segue a interface; a frase citada é a que sai.
    expect(dica).toHaveTextContent(rodapeDeSaida("pt-BR"));
    expect(dica).toHaveTextContent("responda PARAR");
    expect(dica).not.toHaveTextContent("BAJA");
  });

  it("organização em espanhol: a dica mostra 'responde BAJA'", async () => {
    abrir("es");
    const dica = await screen.findByText(/La apertura ya dice cómo detenerse:/);
    expect(dica).toHaveTextContent(rodapeDeSaida("es"));
    expect(dica).toHaveTextContent("responde BAJA");
  });
});
