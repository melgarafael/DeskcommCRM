/**
 * PROVA DE TELA DO #4507 — REMARCAR SEGUE O TIPO DO COMPROMISSO, NÃO O DA GRADE.
 *
 * O defeito, medido na vps-teste: com "Atendimento" selecionado na grade (o
 * padrão, sem `?tipo=`), Remarcar uma "Aula Coletiva" (serviço, 40 min) abria
 * "Agendar Atendimento" com o campo de duração = 40 e a consulta de horários do
 * tipo errado; Confirmar mandava `duration_minutes: 40` e a rota devolvia 422
 * `agenda_duracao_do_servico` — o compromisso não mudava. A causa: `onRemarcar`
 * não levava o tipo do compromisso, e a tela decidia tudo pelo selecionado.
 *
 *     npx vitest run tests/unit/agenda-remarcar-segue-o-tipo-do-compromisso.test.tsx
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
  // `NewContactDialog` (dentro da entrada da agenda) lê a organização ativa para
  // saber o país do formulário. Sem este export o render inteiro cai no mock e
  // NADA da lista aparece — o teste mediria a queda, não o título.
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
 * A FRONTEIRA COM A REDE. O `title` que interessa é o que SAI da tela — guardar
 * os argumentos é a única forma de asseverar isto sem rota nem servidor.
 */
const corposDoPost = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const corposDoPatch = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({
    mutateAsync: async (novo: Record<string, unknown>) => {
      corposDoPost.push(novo);
      return { data: { id: "novo-1" } };
    },
    isPending: false,
  }),
}));

vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({
    mutateAsync: async (entrada: Record<string, unknown>) => {
      corposDoPatch.push(entrada);
      return { data: { id: String(entrada.id) } };
    },
    isPending: false,
  }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/** Quarta 16/09 tem dois horários publicados; o resto do mês não. */
const filtrosDaConsulta = vi.hoisted(() => [] as Array<Record<string, unknown> | null>);
vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: (filtro: Record<string, unknown> | null) => (filtrosDaConsulta.push(filtro), {
    data: {
      slots: [{ inicio: "2026-09-16T13:00:00.000Z" }, { inicio: "2026-09-16T14:00:00.000Z" }],
      fuso_da_regra: "America/Sao_Paulo",
      publicou_horarios: true,
    },
    isError: false,
    isLoading: false,
  }),
}));

/**
 * `data: undefined` de propósito: `_client.tsx` faz
 * `agendamentosVivos ?? (naJanelaDoServidor ? agendamentosIniciais : [])` — um
 * array vazio aqui APAGARIA a semente, e o caso do título na tela mediria a
 * ausência que o mock criou. Sem resposta, a primeira pintura manda.
 */
vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: undefined, isError: false, isLoading: false }),
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

const ATENDIMENTO = {
  id: "tipo-atendimento",
  nome: "Atendimento",
  duracaoMin: 30,
  donoId: null,
  localKind: null,
  localDetalhes: null,
};
const AULA = { ...ATENDIMENTO, id: "tipo-aula", nome: "Aula Coletiva", duracaoMin: 40, servico: true };

function montar(agendamentos: Array<Record<string, unknown>>) {
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
        // "Atendimento" primeiro: é o selecionado sem `?tipo=`, como na prova.
        tiposIniciais={[ATENDIMENTO, AULA]}
        agendamentosIniciais={agendamentos as never}
        podeMarcar
      />
    </QueryClientProvider>,
  );
}

const compromisso = (tipoId: string, termina: string) => ({
  id: "a1",
  revision: 3,
  titulo: "Compromisso",
  responsavelId: "",
  tipoId,
  comeca: "2026-09-16T13:00:00.000Z",
  termina,
  origem: "ui",
  situacao: "confirmed",
});

function remarcarPara10h() {
  fireEvent.click(screen.getByTestId("remarcar-a1"));
  fireEvent.click(screen.getByTestId("dia-2026-09-16"));
  fireEvent.click(screen.getByTestId("horario-10:00"));
  fireEvent.click(screen.getByTestId("confirmar-marcacao"));
}

beforeEach(() => {
  corposDoPatch.length = 0;
  filtrosDaConsulta.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("remarcar um SERVIÇO com outro tipo selecionado na grade", () => {
  it("⭐ o painel é do serviço, sem campo de duração, e o PATCH não leva duration_minutes", async () => {
    montar([compromisso(AULA.id, "2026-09-16T13:40:00.000Z")]);

    fireEvent.click(screen.getByTestId("remarcar-a1"));
    expect(screen.getByText(/Agendar\s+Aula Coletiva/)).not.toBeNull();
    expect(screen.queryByTestId("duracao-do-atendimento")).toBeNull();
    // A lista de horários do painel é a do serviço, e sem duração: quem manda é
    // a agenda publicada. (A grade atrás também consulta, com o tipo DELA.)
    const doPainel = filtrosDaConsulta.filter((f) => f?.event_type_id === AULA.id);
    expect(doPainel.length).toBeGreaterThan(0);
    expect(doPainel.every((f) => f?.duracao_minutos === undefined)).toBe(true);

    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(corposDoPatch).toHaveLength(1));
    expect(corposDoPatch[0]).toMatchObject({ id: "a1", starts_at: "2026-09-16T13:00:00.000Z" });
    expect(corposDoPatch[0]).not.toHaveProperty("duration_minutes", expect.anything());
  });
});

describe("controle: remarcar um atendimento comum continua levando a duração (#4450)", () => {
  it("o PATCH leva o comprimento do bloco como duração", async () => {
    montar([compromisso(ATENDIMENTO.id, "2026-09-16T13:50:00.000Z")]);

    remarcarPara10h();

    await waitFor(() => expect(corposDoPatch).toHaveLength(1));
    expect(corposDoPatch[0]).toMatchObject({ id: "a1", duration_minutes: 50 });
  });
});
