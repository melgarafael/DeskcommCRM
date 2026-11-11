/**
 * O QUADRO POR PROFISSIONAL, como visão da agenda que já existe — issue #4186.
 *
 * O #4219 fez o filtro por profissional mandar no painel, nos horários e no
 * POST. O quadro abre uma porta nova para o MESMO painel: o clique num bloco
 * livre de uma LINHA. E ali o profissional não é o isolado no filtro (com
 * "Todos", ninguém está isolado) nem o dono do tipo — é a pessoa da linha.
 *
 * Este arquivo mede o que a fatia promete:
 *
 *   1. É UMA VISÃO, NÃO UMA TELA: "Quadro" aparece no alternador ao lado de
 *      Dia/Semana/Mês e desenha uma linha por profissional, com os
 *      compromissos de cada um na linha dele.
 *   2. O FILTRO MANDA AQUI TAMBÉM: isolar a Ana deixa uma linha só.
 *   3. A LINHA MANDA NA MARCAÇÃO: clicar no bloco livre da linha da Ana abre o
 *      painel com a Ana e o POST leva `owner_user_id` da Ana — mesmo com o tipo
 *      sendo do Bruno e ninguém isolado. É o defeito que o #4219 fechou para o
 *      filtro, e que o quadro reabriria se a linha não chegasse ao painel.
 *   4. QUEM SÓ LÊ NÃO RECEBE O GESTO: sem permissão de marcar, nenhum bloco do
 *      quadro é clicável.
 *
 * Mesma costura do `_client.test.tsx`: o painel é um stub que imprime
 * `responsavel.nome` e oferece o confirmar.
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
  /**
   * O que a consulta VIVA devolve. Trocar para o quadro muda a janela (de semana
   * para o dia), e fora da janela do servidor a tela só desenha o que o hook
   * trouxe — então aqui o hook traz a lista, como a rota traria.
   */
  vivos: undefined as Agendamento[] | undefined,
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
  // A lista viva (ver `estado.vivos`): o quadro troca a janela para o dia, e a
  // primeira pintura do servidor só vale na janela em que ela foi feita.
  useAgendamentos: () => ({ data: estado.vivos, isError: false, isLoading: false }),
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

vi.mock("@/hooks/agenda/useHorariosLivresPorPessoa", () => ({
  // Cada profissional tem UM horário livre no dia: 16:00. É o bastante para
  // medir de quem é a linha clicada — o motor de verdade tem suíte própria.
  useHorariosLivresPorPessoa: (tipoId: string | null, ids: string[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          slots: tipoId
            ? [{ inicio: "2026-09-16T16:00:00-03:00", fim: "2026-09-16T16:30:00-03:00" }]
            : null,
          falhou: false,
          publicou: true,
        },
      ]),
    ),
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
  estado.vivos = agendamentos;
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(arvore(cliente, agendamentos, podeMarcar));
}

function arvore(cliente: QueryClient, agendamentos: Agendamento[], podeMarcar: boolean) {
  return (
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
    </QueryClientProvider>
  );
}

async function abrirQuadro() {
  await userEvent.click(screen.getByTestId("visao-quadro"));
  return screen.getByTestId("quadro-por-profissional");
}

describe("Quadro por profissional — uma visão da mesma agenda", () => {
  it("'Quadro' está no alternador e desenha uma linha por profissional", async () => {
    montar();

    expect(screen.getByTestId("visao-quadro").textContent).toBe("Quadro");
    const quadro = await abrirQuadro();

    expect(screen.getByTestId("visao-quadro").getAttribute("aria-pressed")).toBe("true");
    expect(quadro.getAttribute("data-dia")).toBe("2026-09-16");
    expect(screen.getByTestId("linha-profissional-ana")).toBeTruthy();
    expect(screen.getByTestId("linha-profissional-bruno")).toBeTruthy();
    // A grade de Dia/Semana sai de cena: são duas visões, não duas telas juntas.
    expect(screen.queryByTestId("grade-da-agenda")).toBeNull();
  });

  it("cada compromisso cai na linha de quem atende", async () => {
    montar();
    await abrirQuadro();

    const linhaDaAna = screen.getByTestId("linha-profissional-ana");
    const linhaDoBruno = screen.getByTestId("linha-profissional-bruno");
    expect(linhaDaAna.querySelector('[data-testid="quadro-agendamento-a1"]')).toBeTruthy();
    expect(linhaDaAna.querySelector('[data-testid="quadro-agendamento-b1"]')).toBeNull();
    expect(linhaDoBruno.querySelector('[data-testid="quadro-agendamento-b1"]')).toBeTruthy();
  });

  it("isolar a Ana no filtro deixa só a linha dela", async () => {
    montar();
    await abrirQuadro();

    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));

    expect(screen.getByTestId("linha-profissional-ana")).toBeTruthy();
    expect(screen.queryByTestId("linha-profissional-bruno")).toBeNull();
  });
});

/**
 * O QUADRO SÓ APARECE COM DOIS OU MAIS PROFISSIONAIS COM AGENDA — decisão do
 * dono do produto (doc 307). Para quem atende sozinho, uma linha por pessoa é
 * a visão Dia deitada: um botão a mais que não serve para nada. A conta sai da
 * mesma lista do filtro de pessoas, e é medida nos dois sentidos.
 */
describe("Quadro por profissional — só com dois ou mais profissionais", () => {
  it("com UM profissional, 'Quadro' não aparece no alternador — e as outras três seguem lá", () => {
    montar({ pessoas: [ANA] });

    expect(screen.queryByTestId("visao-quadro")).toBeNull();
    expect(screen.getByTestId("visao-dia")).toBeTruthy();
    expect(screen.getByTestId("visao-semana")).toBeTruthy();
    expect(screen.getByTestId("visao-mes")).toBeTruthy();
  });

  it("sem NENHUM profissional na lista, 'Quadro' também não aparece", () => {
    montar({ pessoas: [] });

    expect(screen.queryByTestId("visao-quadro")).toBeNull();
  });

  it("com DOIS profissionais, 'Quadro' aparece", () => {
    montar({ pessoas: [ANA, BRUNO] });

    expect(screen.getByTestId("visao-quadro")).toBeTruthy();
  });

  it("se a equipe cai para um com o quadro aberto, a tela volta à visão padrão sem quebrar", async () => {
    const cliente = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    estado.pessoas = [ANA, BRUNO];
    estado.vivos = AGENDAMENTOS;
    const { rerender } = render(arvore(cliente, AGENDAMENTOS, true));
    await abrirQuadro();

    estado.pessoas = [ANA];
    rerender(arvore(cliente, AGENDAMENTOS, true));

    expect(screen.queryByTestId("quadro-por-profissional")).toBeNull();
    expect(screen.queryByTestId("visao-quadro")).toBeNull();
    expect(screen.getByTestId("grade-da-agenda").getAttribute("data-visao")).toBe("semana");
    expect(screen.getByTestId("visao-semana").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Quadro por profissional — a linha clicada manda na marcação", () => {
  it("com 'Todos', clicar no livre da Ana abre o painel da Ana e grava na agenda dela", async () => {
    const corpos: Array<Record<string, unknown>> = [];
    estado.marcar = (corpo) => corpos.push(corpo);

    montar();
    await abrirQuadro();
    estado.consultas = [];

    const celula = screen.getByTestId("celula-ana-16:00");
    expect(celula.getAttribute("data-livre")).toBe("true");
    await userEvent.click(celula);

    // O tipo é do BRUNO e ninguém está isolado: sem a linha chegar ao painel,
    // este nome seria "Bruno Lima" — o defeito que esta asserção prende.
    expect(screen.getByTestId("painel-responsavel").textContent).toBe("Ana Prado");
    const abertas = estado.consultas.filter((c) => c !== null);
    expect(abertas.length).toBeGreaterThanOrEqual(1);
    expect(abertas.every((c) => c!.owner_user_id === ANA.id)).toBe(true);

    await userEvent.click(screen.getByTestId("painel-confirmar"));
    expect(corpos).toHaveLength(1);
    expect(corpos[0]!.owner_user_id).toBe(ANA.id);
    expect(corpos[0]!.event_type_id).toBe("tipo-1");
  });

  it("clicar no livre do Bruno abre o painel do Bruno", async () => {
    const corpos: Array<Record<string, unknown>> = [];
    estado.marcar = (corpo) => corpos.push(corpo);

    montar();
    await abrirQuadro();
    await userEvent.click(screen.getByTestId("celula-bruno-16:00"));

    expect(screen.getByTestId("painel-responsavel").textContent).toBe("Bruno Lima");
    await userEvent.click(screen.getByTestId("painel-confirmar"));
    expect(corpos[0]!.owner_user_id).toBe(BRUNO.id);
  });

  it("bloco sem horário livre não é clicável", async () => {
    montar();
    await abrirQuadro();

    const ocupada = screen.getByTestId("celula-ana-10:00");
    expect(ocupada.getAttribute("data-livre")).toBe("false");
    expect((ocupada as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Quadro por profissional — a permissão é a da área", () => {
  it("sem permissão de marcar, nenhum bloco do quadro é clicável", async () => {
    montar({ podeMarcar: false });
    await abrirQuadro();

    const livre = screen.getByTestId("celula-ana-16:00");
    expect(livre.getAttribute("data-livre")).toBe("true");
    expect((livre as HTMLButtonElement).disabled).toBe(true);
  });
});
