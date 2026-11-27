/**
 * #3067 fatia E3 — "Quem conduz" no painel de marcar.
 *
 * Provam o contrato da TELA com a rota de marcar, que é onde o defeito estava:
 *
 *   1. escolher um adicional → `responsible_user_ids` no corpo do POST, sem o principal;
 *   2. sem adicional → o corpo NÃO tem a chave `responsible_user_ids`;
 *   3. tipo coletivo → aparece `quem-conduz-aviso`; tipo individual → não aparece;
 *   4. o servidor recusa com `responsavel_indisponivel` e `details.user_id` do
 *      adicional → o erro mostrado leva o NOME da pessoa.
 *
 * NÃO provam gravação no banco (nenhuma rota, nenhuma sessão).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaClient } from "@/app/app/agenda/_client";

// A tela pergunta a largura da janela num efeito (no celular a visão padrão é a
// do dia) e o ambiente de teste não traz `matchMedia`.
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
  useActiveOrg: () => ({
    id: "o1",
    orgId: "o1",
    country: "BR",
    timezone: "America/Sao_Paulo",
    role: "agent",
  }),
}));

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));

vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: () => "pt-BR" };
});

/**
 * A FRONTEIRA COM A REDE. O corpo que SAI da tela é a única forma de asseverar
 * o contrato sem rota nem servidor.
 */
const corposDoPost = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const rejeitarComResponsavelIndisponivel = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/agenda/useMarcarAgendamento", () => {
  const mutateAsync = vi.fn(async (novo: Record<string, unknown>) => {
    corposDoPost.push(novo);
    if (rejeitarComResponsavelIndisponivel.value && (novo.responsible_user_ids as string[] | undefined)?.includes("p2")) {
      throw new ApiError(409, "responsavel_indisponivel", { user_id: "p2" }, "req-1");
    }
    return { data: { id: "novo-1" } };
  });
  return {
    useMarcarAgendamento: () => ({
      mutateAsync,
      isPending: false,
    })
  };
});

vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({
    mutateAsync: async (entrada: Record<string, unknown>) => {
      return { data: { id: String(entrada.id) } };
    },
    isPending: false,
  }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({
    data: {
      slots: [{ inicio: "2026-09-16T13:00:00.000Z" }, { inicio: "2026-09-16T14:00:00.000Z" }],
      fuso_da_regra: "America/Sao_Paulo",
      publicou_horarios: true,
    },
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: undefined, isError: false, isLoading: false }),
}));

vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: () => ({ data: PESSOAS, error: false, isLoading: false }),
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

vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: vi.fn(),
}));

import { ApiError } from "@/lib/api/types";

const TIPO_INDIVIDUAL = {
  id: "tipo-individual",
  nome: "Atendimento individual",
  duracaoMin: 30,
  donoId: "p1",
  servicoColetivo: false,
  localKind: null,
  localDetalhes: null,
};

const TIPO_COLETIVO = {
  id: "tipo-coletivo",
  nome: "Aula coletiva",
  duracaoMin: 60,
  donoId: "p1",
  servicoColetivo: true,
  localKind: null,
  localDetalhes: null,
};

const PESSOAS = [
  { id: "p1", nome: "Ana", trilha: 1 },
  { id: "p2", nome: "Bruno", trilha: 2 },
  { id: "p3", nome: "Carla", trilha: 3 },
];

function montar(tipo: typeof TIPO_INDIVIDUAL) {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDaAgenda="America/Sao_Paulo"
        fusoDeApresentacao="America/Sao_Paulo"
        hojeNaOrganizacao="2026-09-16"
        usuarioId="u-atendente"
        googleConfigurado={false}
        faltaNoGoogle={[]}
        tiposIniciais={[tipo]}
        agendamentosIniciais={[]}
        podeMarcar
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  corposDoPost.length = 0;
  rejeitarComResponsavelIndisponivel.value = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Quem conduz ao marcar (#3067)", () => {
  it("sem adicional → o corpo do POST não tem a chave responsible_user_ids", async () => {
    montar(TIPO_INDIVIDUAL);
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(corposDoPost).toHaveLength(1));
    expect(corposDoPost[0].responsible_user_ids).toBeUndefined();
  });

  it("escolher um adicional → responsible_user_ids só com ele (sem o principal)", async () => {
    montar(TIPO_INDIVIDUAL);
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    fireEvent.change(screen.getByTestId("quem-conduz-adicionar"), {
      target: { value: "p2" },
    });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(corposDoPost).toHaveLength(1));
    expect(corposDoPost[0]).toMatchObject({
      responsible_user_ids: ["p2"],
    });
  });

  it("tipo coletivo → aparece quem-conduz-aviso; tipo individual → não aparece", async () => {
    // Coletivo
    montar(TIPO_COLETIVO);
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    expect(screen.getByTestId("quem-conduz-aviso")).toHaveTextContent(
      "Sessão coletiva: quem abre a sessão define a equipe; quem entra depois fica com a mesma.",
    );
    cleanup();

    // Individual
    montar(TIPO_INDIVIDUAL);
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    expect(screen.queryByTestId("quem-conduz-aviso")).not.toBeInTheDocument();
  });

  it("recusa do servidor por pessoa ocupada → a tela diz o NOME dela", async () => {
    rejeitarComResponsavelIndisponivel.value = true;
    montar(TIPO_INDIVIDUAL);
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    fireEvent.change(screen.getByTestId("quem-conduz-adicionar"), {
      target: { value: "p2" },
    });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    expect(await screen.findByText(/Bruno está ocupado neste horário/)).toBeInTheDocument();
  });
});
