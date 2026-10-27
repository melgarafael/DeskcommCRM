/**
 * A AGENDA COM A CAMADA DESLIGADA É A AGENDA DE HOJE, BYTE A BYTE (#3221).
 *
 * ─── Por que este teste existe, e o que ele NÃO é ──────────────────────────
 *
 * A camada "Datas dos negócios" acrescenta um bloco novo na tela que todo
 * mundo usa. A promessa da entrega é que ela seja OPCIONAL de verdade: quem não
 * liga não ganha nem um item, nem uma requisição, nem uma linha diferente na
 * grade. Prometer isso em prosa e não medir é como o produto já pagou caro
 * antes — a mudança que "só acrescenta" acaba mexendo no que existia.
 *
 * ─── O controle, e como ele é medido ──────────────────────────────────────
 *
 *   1. `htmlSemCamada` — a tela renderizada SEM a prop (o estado de hoje).
 *   2. `htmlDesligada` — a mesma tela com funis disponíveis e a camada
 *      desligada (o padrão).
 *   3. Tirando do segundo o bloco da camada (que é só o interruptor), os dois
 *      HTML têm de ser IGUAIS, byte a byte.
 *
 * Além disso: desligada não faz `fetch` nenhum — nem para descobrir se há algo
 * a mostrar. A busca só existe depois de a pessoa ligar a camada e escolher o
 * campo (decisão (a): nenhum campo por padrão).
 *
 * ⚠️ O que este teste NÃO prova: que a tela fica bonita, ou que a grade desenha
 * os compromissos. Ele mede UMA coisa — que a camada desligada não muda o que
 * já existia.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaClient } from "@/app/app/agenda/_client";
import type { FunilComDatas } from "@/lib/agenda/datas-dos-negocios";

// A tela pergunta a largura da janela num efeito e o jsdom não traz
// `matchMedia` (mesmo stub de tests/unit/agenda-viewer-nao-ganha-novo-agendamento).
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/app/agenda",
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u1" }, activeOrg: { id: "o1", role: "agent" } }),
}));

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));

vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: () => "pt-BR" };
});

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({
    data: { slots: [], fuso_da_regra: "America/Sao_Paulo", publicou_horarios: true },
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: [], isError: false, isLoading: false }),
}));

vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: () => ({ data: [], isError: false, isLoading: false }),
}));

vi.mock("@/lib/agenda/vinculo-da-marcacao", () => ({
  useVinculoDaMarcacao: () => ({
    vinculo: { contact: null, conversation: null },
    registrarRota: vi.fn(() => false),
    reiniciar: vi.fn(),
    escolher: vi.fn(),
    escolherVinculo: vi.fn(),
  }),
}));

const TIPOS = [
  {
    id: "tipo-1",
    nome: "Consulta",
    duracaoMin: 30,
    donoId: null,
    localKind: null,
    localDetalhes: null,
  },
];

const FUNIS: FunilComDatas[] = [
  {
    id: "p-viagens",
    nome: "Viagens",
    campos: [
      { key: "data_inicio", label: "Embarque" },
      { key: "data_fim", label: "Retorno" },
    ],
  },
];

function montar(funisComDatas?: FunilComDatas[]) {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDaAgenda="America/Sao_Paulo"
        fusoDeApresentacao="America/Sao_Paulo"
        // Data fixa: o caso não pode depender de quando roda.
        hojeNaOrganizacao="2026-03-11"
        googleConfigurado={false}
        faltaNoGoogle={[]}
        tiposIniciais={TIPOS}
        agendamentosIniciais={[]}
        usuarioId="u-atendente"
        podeMarcar
        {...(funisComDatas ? { funisComDatas } : {})}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
});

describe("Agenda — a camada 'Datas dos negócios' desligada não muda a tela", () => {
  it("sem funil com campo de data: a Agenda é a de antes, sem nem o interruptor", () => {
    const { container } = montar();
    expect(container.querySelector('[data-testid="camada-datas-dos-negocios"]')).toBeNull();
    expect(screen.getByTestId("tela-agenda")).toBeTruthy();
    expect(screen.getByTestId("grade-da-agenda")).toBeTruthy();
  });

  it("desligada é igual a não existir: tirando o interruptor, o HTML bate byte a byte", () => {
    const semCamada = montar().container.innerHTML;
    const { container } = montar(FUNIS);

    const bloco = container.querySelector('[data-testid="camada-datas-dos-negocios"]');
    expect(bloco).toBeTruthy();
    // Desligada, o bloco é SÓ o interruptor: nenhum item, nenhum seletor.
    expect(bloco!.querySelector('[data-testid="camada-datas-itens"]')).toBeNull();
    expect(bloco!.querySelector('[data-testid="camada-datas-campo"]')).toBeNull();
    expect(bloco!.querySelectorAll('[data-testid^="camada-datas-dia-"]')).toHaveLength(0);
    expect(bloco!.textContent?.trim()).toBe("Datas dos negócios");

    // O CONTROLE, na letra: o resto da tela é idêntico ao de antes da entrega.
    const semBloco = container.cloneNode(true) as HTMLElement;
    semBloco.querySelector('[data-testid="camada-datas-dos-negocios"]')!.remove();
    expect(semBloco.innerHTML).toBe(semCamada);
  });

  it("desligada não faz busca nenhuma — nem para saber se há o que mostrar", () => {
    montar(FUNIS);
    expect(fetch).not.toHaveBeenCalled();
  });
});
