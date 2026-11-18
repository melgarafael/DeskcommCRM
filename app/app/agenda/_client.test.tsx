/**
 * A AGENDA POR PROFISSIONAL, NA TELA QUE JÁ EXISTE — issue #4186.
 *
 * A issue descreve um "quadro por profissional". Ele não existe, e esta fatia não
 * cria uma segunda tela: o que entra é o FILTRO por profissional no cabeçalho da
 * agenda que já existe (`_client.tsx:704`, componente `FiltroDePessoas`).
 *
 * Este arquivo mede o que o filtro promete — e o que ele não pode prometer:
 *
 *   1. LISTA: escolher uma pessoa mostra só os compromissos dela; "Todos" volta
 *      à lista completa. É a frase do critério, verificada no DOM (os cards da
 *      grade têm `data-testid="agendamento-<id>"`).
 *   2. PERMISSÃO SEM REGRA NOVA: quem não pode ler a lista da equipe
 *      (`GET /api/v1/agenda/pessoas`, piso `agent`) recebe 403, a lista chega
 *      vazia e o filtro NÃO é desenhado. A leitura da grade continua a da
 *      organização — a tela não inventa escopo; ela só não oferece a escolha
 *      que a rota recusaria.
 *   3. COERÊNCIA DO PROFISSIONAL: com alguém isolado, o painel de marcação, a
 *      consulta de horários livres e o POST falam do MESMO profissional. Sem
 *      isto o filtro é cosmético: você isola a Ana, clica num bloco livre e o
 *      compromisso nasce na agenda do dono do tipo (Bruno) — e desaparece da
 *      visão que você acabou de filtrar.
 *
 * O painel real é substituído por um stub que imprime `responsavel.nome` e
 * oferece o botão de confirmar: é a prop que o painel de verdade escreve na
 * tela (`PainelDeMarcacao.tsx:784`), então ela é a costura certa a medir aqui, e
 * o painel de verdade tem suíte própria.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaClient } from "@/app/app/agenda/_client";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";

const estado = vi.hoisted(() => ({
  pessoas: [] as Array<{ id: string; nome: string; trilha: number }>,
  /** Argumento de cada render de `useHorariosLivres` — `null` = painel fechado. */
  consultas: [] as Array<Record<string, unknown> | null>,
  marcar: null as null | ((corpo: Record<string, unknown>) => void),
}));

beforeAll(() => {
  // A tela pergunta a largura num efeito; sem `matchMedia` o render morre com
  // "window.matchMedia is not a function", que não é o que este teste mede.
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

beforeEach(() => {
  estado.consultas = [];
  estado.pessoas = [];
});

afterEach(cleanup);

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

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));

// `EntradaDaAgenda` pergunta a permissão de rota ao provider; sem ele o render
// inteiro morre em "must be used inside <AuthProvider>", que não é o que se mede.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u-eu" }, activeOrg: { id: "o1", role: "agent" } }),
  // O painel abre com o campo de cliente, e `NewContactDialog` lê o país da org.
  useActiveOrg: () => ({ id: "o1", role: "agent", country: "BR" }),
}));

vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: () => "pt-BR" };
});

vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  // `undefined` = o hook ainda não trouxe nada, e a tela cai na PRIMEIRA pintura
  // do servidor (`agendamentosIniciais`) — que é o caminho que este teste mede.
  useAgendamentos: () => ({ data: undefined, isError: false, isLoading: false }),
}));

vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: () => ({ data: estado.pessoas, isError: false, isLoading: false }),
}));

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: (filtro: Record<string, unknown> | null) => {
    estado.consultas.push(filtro);
    return {
      data: { slots: [], fuso_da_regra: "America/Sao_Paulo", publicou_horarios: true },
      isError: false,
      isLoading: false,
    };
  },
}));

vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({
    mutateAsync: async (corpo: Record<string, unknown>) => {
      estado.marcar?.(corpo);
      return { data: { id: "novo" } };
    },
    isPending: false,
  }),
}));

vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

/** Stub do painel: imprime a pessoa resolvida e oferece o confirmar. */
vi.mock("@/components/agenda/PainelDeMarcacao", () => ({
  PainelDeMarcacao: (props: {
    responsavel: Pessoa;
    onConfirmar?: (instante: string, duracao: number) => Promise<unknown>;
  }) => (
    <div data-testid="painel-stub">
      <span data-testid="painel-responsavel">{props.responsavel.nome}</span>
      <button
        type="button"
        data-testid="painel-confirmar"
        onClick={() => {
          void props.onConfirmar?.("2026-09-16T16:00:00-03:00", 30);
        }}
      >
        confirmar
      </button>
    </div>
  ),
}));

const ANA: Pessoa = { id: "ana", nome: "Ana Prado", trilha: 1 };
const BRUNO: Pessoa = { id: "bruno", nome: "Bruno Lima", trilha: 2 };

const TIPOS = [
  {
    id: "tipo-1",
    nome: "Consulta",
    duracaoMin: 30,
    // O dono do tipo é o Bruno: sem isolamento, é ele que o painel mostra e é
    // na agenda dele que o POST cai (o comportamento de antes).
    donoId: BRUNO.id,
    localKind: null,
    localDetalhes: null,
  },
];

const AGENDAMENTOS: Agendamento[] = [
  {
    id: "a1",
    titulo: "Retorno — Ana",
    responsavelId: ANA.id,
    comeca: "2026-09-16T13:00:00-03:00",
    termina: "2026-09-16T13:30:00-03:00",
    origem: "ui",
    situacao: "confirmed",
  },
  {
    id: "b1",
    titulo: "Avaliação — Bruno",
    responsavelId: BRUNO.id,
    comeca: "2026-09-16T14:00:00-03:00",
    termina: "2026-09-16T14:30:00-03:00",
    origem: "ui",
    situacao: "confirmed",
  },
];

function montar({
  pessoas = [ANA, BRUNO],
  agendamentos = AGENDAMENTOS,
  podeMarcar = true,
}: {
  pessoas?: Pessoa[];
  agendamentos?: Agendamento[];
  podeMarcar?: boolean;
} = {}) {
  estado.pessoas = pessoas.map((p) => ({ id: p.id, nome: p.nome, trilha: p.trilha }));
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDaAgenda="America/Sao_Paulo"
        fusoDeApresentacao="America/Sao_Paulo"
        hojeNaOrganizacao="2026-09-16"
        usuarioId="u-eu"
        googleConfigurado={false}
        faltaNoGoogle={[]}
        tiposIniciais={TIPOS}
        agendamentosIniciais={agendamentos}
        podeMarcar={podeMarcar}
      />
    </QueryClientProvider>,
  );
}

describe("Agenda por profissional — a lista filtrada", () => {
  it("nasce em 'todos': os compromissos dos dois profissionais aparecem", () => {
    montar();

    expect(screen.getByTestId("filtro-de-pessoas").getAttribute("data-isolada")).toBe("todos");
    expect(screen.getByTestId("agendamento-a1")).toBeTruthy();
    expect(screen.getByTestId("agendamento-b1")).toBeTruthy();
  });

  it("escolher a Ana mostra só os compromissos dela", async () => {
    montar();

    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));

    expect(screen.getByTestId("filtro-de-pessoas").getAttribute("data-isolada")).toBe("ana");
    expect(screen.getByTestId("agendamento-a1")).toBeTruthy();
    expect(screen.queryByTestId("agendamento-b1")).toBeNull();
  });

  it("'Todos' devolve a lista completa", async () => {
    montar();

    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(screen.queryByTestId("agendamento-b1")).toBeNull();

    await userEvent.click(screen.getByTestId("botao-todos"));

    expect(screen.getByTestId("filtro-de-pessoas").getAttribute("data-isolada")).toBe("todos");
    expect(screen.getByTestId("agendamento-a1")).toBeTruthy();
    expect(screen.getByTestId("agendamento-b1")).toBeTruthy();
  });

  it("isolar quem não tem compromisso na janela esvazia a grade, e 'Todos' a repõe", async () => {
    montar({ agendamentos: [AGENDAMENTOS[1]!] });

    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(screen.queryByTestId("agendamento-b1")).toBeNull();

    await userEvent.click(screen.getByTestId("botao-todos"));
    expect(screen.getByTestId("agendamento-b1")).toBeTruthy();
  });
});

describe("Agenda por profissional — a permissão é a da área", () => {
  /**
   * `viewer` não lê `/api/v1/agenda/pessoas` (piso `agent`, ver
   * `lib/agenda/lista-de-pessoas.ts`), então a lista chega vazia. O que este
   * teste fixa: a tela NÃO inventa um caminho alternativo — sem lista, não há
   * filtro — e a grade que a pessoa já podia ler continua de pé.
   */
  it("sem a lista da equipe, a opção não existe e a grade inteira segue visível", () => {
    montar({ pessoas: [], podeMarcar: false });

    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
    expect(screen.getByTestId("tela-agenda")).toBeTruthy();
    expect(screen.getByTestId("agendamento-a1")).toBeTruthy();
    expect(screen.getByTestId("agendamento-b1")).toBeTruthy();
  });
});

describe("Agenda por profissional — o filtro manda no painel, nos horários e no POST", () => {
  it("sem ninguém isolado, o painel é o dono do TIPO e a consulta não manda dono", async () => {
    montar();

    await userEvent.click(screen.getByTestId("novo-agendamento"));

    expect(screen.getByTestId("painel-responsavel").textContent).toBe("Bruno Lima");
    const ultima = estado.consultas[estado.consultas.length - 1];
    expect(ultima).not.toBeNull();
    // Omitir o dono é o contrato atual: quem resolve é a rota, pela MESMA regra
    // do motor (`_handler.ts:96`). Regressão aqui é o 422 medido em #3709.
    expect(ultima!.owner_user_id).toBeUndefined();
  });

  it("isolando a Ana, o painel, a grade, os horários livres e o agendamento vão para a Ana", async () => {
    const corpos: Array<Record<string, unknown>> = [];
    estado.marcar = (corpo) => corpos.push(corpo);

    montar();
    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));

    // A partir daqui só interessa o que a tela pergunta DEPOIS de isolar.
    estado.consultas = [];
    await userEvent.click(screen.getByTestId("novo-agendamento"));

    expect(screen.getByTestId("painel-responsavel").textContent).toBe("Ana Prado");

    // DUAS consultas, duas superfícies: a grade (a janela que ela desenha) e o
    // painel (o mês que ele mostra). As duas têm de ser da Ana — oferecer a
    // jornada de um e gravar no outro é o 422 medido em #3709.
    const abertas = estado.consultas.filter((c) => c !== null);
    expect(abertas.length).toBeGreaterThanOrEqual(2);
    expect(abertas.every((c) => c!.owner_user_id === ANA.id)).toBe(true);

    await userEvent.click(screen.getByTestId("painel-confirmar"));

    expect(corpos).toHaveLength(1);
    expect(corpos[0]!.owner_user_id).toBe(ANA.id);
    expect(corpos[0]!.event_type_id).toBe("tipo-1");
  });
});
