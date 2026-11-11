// components/kanban/dossie-dos-numeros.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import type { Lead } from "@/lib/types/leads";

import { LeadDossier } from "./LeadDossier";

/**
 * O NEGÓCIO ENXERGA TODOS OS NÚMEROS DO CLIENTE (#3669, fatia 1).
 *
 * ─── O defeito, medido na tela ──────────────────────────────────────────────
 *
 * O dossiê mostrava a conversa do `crm_leads.contact_id` e mais nada: a conversa
 * do comprador — que fala de outro WhatsApp, e por isso é outro contato — e o
 * histórico da ligação para o fixo da loja existiam no banco e não apareciam no
 * negócio. Este arquivo monta o dossiê com um relacionado que TEM conversa e
 * ligação e exige as duas na tela; no código de antes da entrega, esta é a
 * asserção que falha.
 *
 * ─── Por que o mock está no `apiClient`, e não no componente ────────────────
 *
 * Mockar `ConversasDosNumeros` provaria que a seção foi montada, não que a
 * conversa do segundo número chega à tela. Aqui as duas rotas de leitura
 * (`contatos-relacionados` e `conversas-e-ligacoes`) respondem pelo `apiClient`
 * — a mesma camada que a tela usa — e o que se lê é o DOM.
 *
 * O lado oposto também está aqui: negócio SEM relacionado não ganha seção
 * nenhuma. "Nada a mais" é requisito, não detalhe: quem tem um número só não
 * pode ver a tela mudar por causa de uma feature que não usa.
 */

vi.mock("@/lib/api/client");
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
  usePermission: () => false,
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: [],
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));
vi.mock("./ContatoDoNegocio", () => ({ ContatoDoNegocio: () => <div data-peca="contato" /> }));
vi.mock("./LeadFieldsForm", () => ({ LeadFieldsForm: () => <div data-peca="campos" /> }));
vi.mock("./TarefasDoNegocio", () => ({ TarefasDoNegocio: () => <div data-peca="tarefas" /> }));
vi.mock("./PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("./ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("./ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("./OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("./LeadTimeline", () => ({ LeadTimeline: () => null }));

const PRINCIPAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEGUNDO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LEAD = {
  id: "lead-1",
  title: "Distribuidora — pedido do mês",
  contact_id: PRINCIPAL,
  contact_phone: "+5511999990000",
  value_cents: 250000,
  currency: "BRL",
  score: null,
  conversa: null,
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
} as unknown as Lead;

const NUMEROS = {
  numeros: [
    { contact_id: PRINCIPAL, nome: "Dono da loja", telefone: "+5511999990000", papel: "principal", papel_do_vinculo: null },
    {
      contact_id: SEGUNDO,
      nome: "Comprador",
      telefone: "+5511988887777",
      papel: "relacionado",
      papel_do_vinculo: "comprador",
    },
  ],
  conversas: [
    {
      id: "conv-segundo",
      contact_id: SEGUNDO,
      previa: "manda o pedido",
      ultima_em: "2026-11-02T10:00:00.000Z",
      nao_lidas: 3,
    },
  ],
  ligacoes: [
    {
      id: "call-segundo",
      contact_id: SEGUNDO,
      direcao: "outbound",
      atendida: false,
      em_andamento: false,
      comecou_em: "2026-11-02T09:00:00.000Z",
      duracao_ms: null,
      motivo_do_fim: "busy",
    },
  ],
};

/** Uma pessoa relacionada, como a rota `contatos-relacionados` devolve. */
const RELACIONADOS = {
  data: [
    {
      contact_id: SEGUNDO,
      nome: "Comprador",
      papel: "comprador",
      anonimizado: false,
      telefone: "+5511988887777",
      conversa_id: "conv-segundo",
    },
  ],
};

function montar(relacionados: unknown) {
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url.includes("/contatos-relacionados")) return relacionados;
    if (url.includes("/conversas-e-ligacoes")) return { data: NUMEROS };
    return { data: [] };
  }) as never);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LeadDossier open onOpenChange={() => undefined} lead={LEAD} pipelineId="funil-1" fieldDefs={[]} stageName="Novo" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("o dossiê mostra as conversas e ligações de todos os números (#3669)", () => {
  it("⭐ a conversa do 2º número aparece — não só a do contato principal", async () => {
    montar(RELACIONADOS);

    // A seção existe porque há pessoa relacionada…
    const secao = await waitFor(() => {
      const no = document.querySelector('[data-secao="numeros-do-negocio"]');
      expect(no, "a seção dos números não está no DOM").not.toBeNull();
      return no as HTMLElement;
    });

    // …e dentro dela está a conversa do SEGUNDO número, com o nome e o telefone
    // dele (é o que distingue o comprador do dono da loja).
    const conversa = await waitFor(() => {
      const no = secao.querySelector("[data-conversa]");
      expect(no, "a conversa do 2º número não aparece no negócio").not.toBeNull();
      return no as HTMLElement;
    });
    expect(conversa.getAttribute("data-conversa")).toBe("conv-segundo");
    expect(conversa.textContent).toContain("Comprador");
    expect(conversa.textContent).toContain("+5511988887777");
    expect(conversa.textContent).toContain("manda o pedido");
    // O link leva ao inbox DESTA conversa.
    expect(conversa.querySelector("a")?.getAttribute("href")).toBe("/app/inbox?id=conv-segundo");
  });

  it("⭐ a ligação do 2º número aparece, com o desfecho", async () => {
    montar(RELACIONADOS);

    const ligacao = await waitFor(() => {
      const no = document.querySelector('[data-ligacao="call-segundo"]');
      expect(no, "a ligação do 2º número não aparece no negócio").not.toBeNull();
      return no as HTMLElement;
    });
    expect(ligacao.textContent).toContain("Comprador");
    expect(ligacao.textContent).toContain("Feita");
    expect(ligacao.textContent).toContain("Não atendida");
  });

  it("⭐ negócio SEM pessoa relacionada não ganha seção: nada a mais, nada a menos", async () => {
    montar({ data: [] });

    // Espera a resposta das rotas para não medir o "antes" do carregamento.
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(apiClient.get).mock.calls.some(([url]) => String(url).includes("/contatos-relacionados"))).toBe(
        true,
      ),
    );

    expect(document.querySelector('[data-secao="numeros-do-negocio"]')).toBeNull();
    expect(screen.queryByText("Conversas e ligações dos números")).not.toBeInTheDocument();
    // E a seção que já existia continua onde estava.
    expect(document.querySelector('[data-secao="contato"]')).not.toBeNull();
    expect(document.querySelector('[data-secao="linha-do-tempo"]')).not.toBeNull();
  });

  it("a rota dos outros números só é chamada quando há relacionado", async () => {
    montar({ data: [] });

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    const chamadas = vi.mocked(apiClient.get).mock.calls.map(([url]) => String(url));
    expect(chamadas.some((u) => u.includes("/conversas-e-ligacoes"))).toBe(false);
  });
});
