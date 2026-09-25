/**
 * #1657 — O TIPO ESCOLHIDO NA GRADE SOBREVIVE AO F5.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────
 *
 * Escolher "Avaliação" na grade era `useState` puro: a escolha morria no
 * recarregamento e a tela voltava ao primeiro tipo em ordem alfabética
 * ("Atendimento"). Quem recarregava via OUTRA agenda — e, se o primeiro tipo
 * não tivesse jornada publicada, via a grade inteira dizer "a jornada de
 * atendimento ainda não foi publicada". Evidência na issue: runs 36061761510
 * e 36164033754, achadas enquanto se investigava o e2e intermitente do arraste
 * (#1656): o aviso nascia entre duas leituras de bounding box e a distância
 * vertical "mudava" 42px sem a tela se mexer.
 *
 * ─── Por que estes casos ─────────────────────────────────────────────────
 *
 * O conserto é a URL (`?tipo=`), no mesmo formato do `?id=` da Inbox (#1629),
 * e ele tem DUAS metades que podem quebrar separadamente:
 *
 *   1. LER — abrir `/app/agenda?tipo=X` tem de pintar X, e não o primeiro.
 *      É o caso do F5 E o deep link aberto em outra aba: são o MESMO caminho,
 *      uma montagem nova com a query na mão.
 *   2. GRAVAR — clicar num tipo tem de deixar `?tipo=` na barra de endereço,
 *      senão a montagem seguinte não tem o que ler.
 *
 * E duas bordas que o conserto poderia abrir:
 *
 *   • sem escolha nenhuma, o padrão de antes (primeiro tipo) continua sendo o
 *     padrão — a URL vazia não pode virar tipo nenhum;
 *   • `?tipo=` apontando para um tipo que foi desativado cai no primeiro, como
 *     sempre, em vez de deixar a tela sem tipo (`null`) e sem botão de marcar.
 *
 * O terceiro caso fecha o buraco que o conserto deixaria aberto: fechar o
 * detalhe de um compromisso fazia `router.replace("/app/agenda")`, apagando
 * TODA a query — inclusive o tipo escolhido minutos antes.
 *
 * A medição dos horários não é conforto: o critério da issue é que, depois do
 * reload, "os horários pedidos são os daquele tipo". Pedir os horários do
 * primeiro tipo é exatamente como este defeito se manifesta na tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaClient } from "@/app/app/agenda/_client";

// A tela pergunta a largura da janela num efeito (no celular a visão padrão é o
// dia) e o ambiente de teste não traz `matchMedia`.
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

/**
 * A URL é o estado que este arquivo mede, então ela é REAL: `useSearchParams`
 * lê `window.location` e `router.replace` grava por ali também. Um mock que
 * devolvesse uma query fixa provaria o leitor sem provar a escrita — e a
 * escrita é metade do defeito.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (url: string) => window.history.replaceState(null, "", url),
    push: (url: string) => window.history.pushState(null, "", url),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/app/agenda",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u1" }, activeOrg: { id: "o1", role: "agent" } }),
}));

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));

vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: "pt-BR" };
});

/**
 * OS PEDIDOS DE HORÁRIO, na ordem em que a tela os faz.
 *
 * O hook é a fronteira com a rede, e o critério da issue é sobre ele: depois do
 * reload os horários pedidos são os do TIPO ESCOLHIDO. Guardar os argumentos é
 * a única forma de asseverar isto sem rota nem servidor — o valor do tipo na
 * tela pode estar certo enquanto a grade pede a disponibilidade de outro.
 */
const pedidos = vi.hoisted(
  () => [] as Array<{ event_type_id: string } | null>,
);
vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: (argumento: { event_type_id: string } | null) => {
    pedidos.push(argumento);
    return {
      data: { slots: [], fuso_da_regra: "America/Sao_Paulo", publicou_horarios: true },
      isError: false,
      isLoading: false,
    };
  },
}));

/** Vazio por padrão; o caso do card da grade põe um compromisso aqui. */
const compromissosDaGrade = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: compromissosDaGrade, isError: false, isLoading: false }),
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

/**
 * O DETALHE VIRA UM BOTÃO. Ele é renderizado dentro da tela e é o componente
 * que fecha com `router.replace("/app/agenda")` — o gesto que apagava a query
 * inteira junto com o tipo. Substituí-lo por um botão deixa esse caminho
 * montável sem rede: o que se mede aqui é a URL que o fecho deixa para trás,
 * não o conteúdo do detalhe.
 */
vi.mock("@/components/agenda/DetalheDoCompromisso", () => ({
  DetalheDoCompromisso: ({ id, onClose }: { id: string | null; onClose: () => void }) =>
    id ? (
      <button data-testid="fechar-detalhe" onClick={onClose}>
        fechar
      </button>
    ) : null,
}));

/** Os dois tipos, na ordem em que `page.tsx` os entrega (por NOME). */
const TIPOS = [
  {
    id: "tipo-1",
    nome: "Atendimento",
    duracaoMin: 30,
    donoId: null,
    localKind: null,
    localDetalhes: null,
  },
  {
    id: "tipo-2",
    nome: "Avaliação",
    duracaoMin: 45,
    donoId: null,
    localKind: null,
    localDetalhes: null,
  },
];

/** Abre a tela como quem abre a aba: URL primeiro, montagem depois. */
function montar() {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tela = () => (
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDeApresentacao="America/Sao_Paulo"
        hojeNaOrganizacao="2026-09-16"
        googleConfigurado={false}
        faltaNoGoogle={[]}
        tiposIniciais={TIPOS}
        agendamentosIniciais={[]}
        usuarioId="u-atendente"
        podeMarcar
      />
    </QueryClientProvider>
  );
  const montada = render(tela());
  // O que o router faz depois de um `push` que só troca a query: renderiza a
  // MESMA árvore de novo, e quem lê `useSearchParams` passa a ver a URL nova.
  return { ...montada, navegou: () => montada.rerender(tela()) };
}

/** O F5: a URL manda, o React nasce do zero. */
function abrirCom(url: string) {
  window.history.replaceState(null, "", url);
}

const botaoDoTipo = (id: string) => screen.getByTestId(`tipo-da-grade-${id}`);

beforeEach(() => {
  abrirCom("/app/agenda");
  pedidos.length = 0;
  compromissosDaGrade.length = 0;
});

afterEach(cleanup);

describe("o tipo escolhido na grade sobrevive ao reload", () => {
  it("sem ?tipo na URL, o padrão continua sendo o primeiro tipo", () => {
    montar();
    expect(botaoDoTipo("tipo-1")).toHaveAttribute("aria-pressed", "true");
    expect(botaoDoTipo("tipo-2")).toHaveAttribute("aria-pressed", "false");
    // E o padrão é quem a grade pergunta: o primeiro tipo, como sempre. A
    // primeira chamada do hook vem do painel ainda fechado (`null`); quem
    // decide a disponibilidade pedida é a da grade.
    const consultas = pedidos.filter((p): p is { event_type_id: string } => p !== null);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.event_type_id).toBe("tipo-1");
  });

  it("com ?tipo=tipo-2, o F5 (e o deep link em outra aba) pintam o MESMO tipo", () => {
    abrirCom("/app/agenda?tipo=tipo-2");
    montar();

    expect(botaoDoTipo("tipo-2")).toHaveAttribute("aria-pressed", "true");
    expect(botaoDoTipo("tipo-1")).toHaveAttribute("aria-pressed", "false");
  });

  it("depois do reload a grade pede os horários do tipo escolhido, não do primeiro", () => {
    abrirCom("/app/agenda?tipo=tipo-2");
    montar();

    const consultas = pedidos.filter((p): p is { event_type_id: string } => p !== null);
    expect(consultas.length).toBeGreaterThan(0);
    // É este o critério da issue: sem ele, a tela pintaria "Avaliação" e a
    // rota responderia pela jornada de "Atendimento" — o aviso indevido.
    for (const consulta of consultas) {
      expect(consulta.event_type_id).toBe("tipo-2");
    }
  });

  it("escolher outro tipo grava ?tipo= na URL — e o F5 seguinte cai nele", () => {
    montar();
    expect(window.location.search).toBe("");

    fireEvent.click(botaoDoTipo("tipo-2"));

    expect(botaoDoTipo("tipo-2")).toHaveAttribute("aria-pressed", "true");
    expect(window.location.search).toContain("tipo=tipo-2");

    // O F5 de verdade: a tela morre, a URL fica.
    cleanup();
    pedidos.length = 0;
    montar();
    expect(botaoDoTipo("tipo-2")).toHaveAttribute("aria-pressed", "true");
    for (const consulta of pedidos.filter((p) => p !== null)) {
      expect(consulta!.event_type_id).toBe("tipo-2");
    }
  });

  it("fechar o detalhe de um compromisso NÃO apaga o tipo escolhido", () => {
    abrirCom("/app/agenda?tipo=tipo-2&compromisso=c1");
    montar();

    fireEvent.click(screen.getByTestId("fechar-detalhe"));

    // O fecho continua limpando o detalhe — é para isso que ele faz replace.
    expect(window.location.search).not.toContain("compromisso");
    // Mas o tipo atravessa: apagá-lo aqui devolveria o defeito a um clique de
    // distância de quem só estava lendo um compromisso.
    expect(window.location.search).toContain("tipo=tipo-2");
  });

  // O caso acima parte de uma URL montada à mão, com os dois parâmetros. A
  // jornada real é outra: o tipo está na URL, a pessoa TOCA NUM CARD da grade,
  // e é o `router.push` do card que monta a URL do detalhe. Enquanto ele
  // montava só `?compromisso=`, o fecho não tinha tipo nenhum para manter.
  it("abrir um compromisso pelo card da grade e fechar mantém o tipo", () => {
    compromissosDaGrade.push({
      id: "c1",
      titulo: "Avaliação",
      responsavelId: "u-atendente",
      comeca: "2026-09-16T11:00:00-03:00",
      termina: "2026-09-16T11:45:00-03:00",
      origem: "ui",
      situacao: "confirmed",
    });
    abrirCom("/app/agenda?tipo=tipo-2");
    const tela = montar();

    fireEvent.click(screen.getByTestId("agendamento-c1"));

    const aberta = new URLSearchParams(window.location.search);
    expect(aberta.get("compromisso")).toBe("c1");
    expect(aberta.get("tipo")).toBe("tipo-2");

    tela.navegou();
    expect(botaoDoTipo("tipo-2")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("fechar-detalhe"));

    expect(window.location.search).toBe("?tipo=tipo-2");
  });

  it("?tipo= de um tipo que não existe mais cai no primeiro — a tela segue de pé", () => {
    abrirCom("/app/agenda?tipo=que-foi-desativado");
    montar();

    expect(botaoDoTipo("tipo-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("novo-agendamento")).toBeTruthy();
  });
});
