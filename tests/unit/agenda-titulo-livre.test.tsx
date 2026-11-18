/**
 * #3766 — O TÍTULO LIVRE DO COMPROMISSO ("OS 1234", "Atendimento fulano").
 *
 * ─── O defeito, medido antes de escrever ─────────────────────────────────
 *
 * A coluna existia (`calendar_appointments.title not null`) e a rota TAMBÉM já a
 * aceitava (`marcarSchema.title`, `_handler.ts:508` grava `title ?? tipo.name`).
 * O que faltava era o CAMPO: a tela montava o corpo do POST sem `title` em
 * `app/app/agenda/_client.tsx`, então 100% das marcações feitas por gente
 * nasciam com o nome do tipo — e quem usava a agenda para atendimento externo
 * não tinha onde escrever o que de fato é o compromisso.
 *
 * ─── O que estes casos provam, e o que eles NÃO provam ───────────────────
 *
 * Provam o contrato da TELA com a rota, que é onde o defeito estava:
 *
 *   1. texto digitado → `title` no corpo do POST (exatamente o digitado);
 *   2. campo em branco → o corpo sai SEM `title`, e o servidor continua
 *      decidindo (`title ?? tipo.name`). É o "comportamento de hoje" medido no
 *      corpo, não no texto da tela;
 *   3. a grade/histórico mostram o título que veio do banco — `page.tsx` já lê
 *      `a.title`, então o que se mede aqui é que ele CHEGA ao bloco;
 *   4. o campo não existe em REMARCAR: `fn_appointment_change_core`
 *      (`supabase/baseline.sql`) tem uma lista fechada de campos no `p_patch` e
 *      `title` não está nela — o PATCH devolveria 200 sem mudar o título, que é
 *      a pior forma de recusar. O caso deixa a fronteira escrita.
 *
 * NÃO provam gravação no banco (nenhuma rota, nenhuma sessão) nem o evento do
 * Google: isso é `route.test.ts` e o gate de banco, fora do escopo daqui.
 *
 *     npx vitest run tests/unit/agenda-titulo-livre.test.tsx
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

const TIPO = {
  id: "tipo-1",
  nome: "Consulta",
  duracaoMin: 30,
  donoId: null,
  localKind: null,
  localDetalhes: null,
};

function montar(agendamentos: Array<Record<string, unknown>> = []) {
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
        tiposIniciais={[TIPO]}
        agendamentosIniciais={agendamentos as never}
        podeMarcar
      />
    </QueryClientProvider>,
  );
}

/** Marca no único horário publicado: dia 16, 10:00 (parede de São Paulo). */
function escolherHorarioEConfirmar() {
  fireEvent.click(screen.getByTestId("novo-agendamento"));
  fireEvent.click(screen.getByTestId("dia-2026-09-16"));
  fireEvent.click(screen.getByTestId("horario-10:00"));
  fireEvent.click(screen.getByTestId("confirmar-marcacao"));
}

beforeEach(() => {
  corposDoPost.length = 0;
  corposDoPatch.length = 0;
  // Só `Date`: congelar timers do React faria o painel nunca sair do lugar.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("o título livre é o nome do compromisso na agenda", () => {
  it("texto digitado vai no corpo do POST, como o `title` da linha", async () => {
    montar();
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    // O campo existe já na abertura do painel — antes de escolher horário.
    fireEvent.change(screen.getByTestId("titulo-do-compromisso"), {
      target: { value: "OS 1234" },
    });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(corposDoPost).toHaveLength(1));
    expect(corposDoPost[0]).toMatchObject({ title: "OS 1234" });
    // O resto do corpo continua íntegro: o título não substitui nada.
    expect(corposDoPost[0]).toMatchObject({
      event_type_id: "tipo-1",
      starts_at: "2026-09-16T13:00:00.000Z",
    });
  });

  it("espaços em volta são aparados — o que a grade mostra é o que foi digitado", async () => {
    montar();
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    fireEvent.change(screen.getByTestId("titulo-do-compromisso"), {
      target: { value: "  Atendimento fulano  " },
    });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(corposDoPost).toHaveLength(1));
    expect(corposDoPost[0]).toMatchObject({ title: "Atendimento fulano" });
  });

  it("campo em branco não manda `title`: o nome do tipo continua sendo o título", async () => {
    montar();
    escolherHorarioEConfirmar();

    await waitFor(() => expect(corposDoPost).toHaveLength(1));
    // `undefined`, e não `""`: `marcarSchema.title` é `min(1)`, e a string vazia
    // viraria 422 no caminho de quem não usou o campo. Na serialização do
    // `apiClient` (JSON) a chave com `undefined` não existe.
    expect(corposDoPost[0]?.title).toBeUndefined();
  });

  it("só espaços também não manda `title` — branco é branco", async () => {
    montar();
    fireEvent.click(screen.getByTestId("novo-agendamento"));
    fireEvent.change(screen.getByTestId("titulo-do-compromisso"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(corposDoPost).toHaveLength(1));
    expect(corposDoPost[0]?.title).toBeUndefined();
  });
});

describe("a agenda mostra o título que veio do banco", () => {
  it("o texto gravado em `title` aparece na tela, e não o nome do tipo", () => {
    montar([
      {
        id: "a1",
        revision: 1,
        titulo: "OS 1234 · Atendimento fulano",
        responsavelId: "",
        comeca: "2026-09-16T13:00:00.000Z",
        termina: "2026-09-16T13:30:00.000Z",
        origem: "ui",
        situacao: "confirmed",
      },
    ]);

    expect(screen.getAllByText("OS 1234 · Atendimento fulano").length).toBeGreaterThan(0);
  });
});

describe("o campo é da CRIAÇÃO — remarcar não o oferece", () => {
  it("remarcar abre o painel sem campo de título: o PATCH não tem onde gravá-lo", () => {
    montar([
      {
        id: "a1",
        revision: 1,
        titulo: "OS 1234",
        responsavelId: "",
        comeca: "2026-09-16T13:00:00.000Z",
        termina: "2026-09-16T13:30:00.000Z",
        origem: "ui",
        situacao: "confirmed",
      },
    ]);

    fireEvent.click(screen.getByTestId("remarcar-a1"));

    expect(screen.queryByTestId("titulo-do-compromisso")).toBeNull();
  });
});
