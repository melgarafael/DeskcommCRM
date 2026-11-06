import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pipeline, Stage } from "@/lib/kanban/types";

import { PipelinePageClient } from "./_client";

/**
 * A ABA LISTA ABRE SEM PAGAR A LEITURA DO QUADRO (#3172, item 4 do CR).
 *
 * ─── O defeito que este arquivo prende ──────────────────────────────────────
 *
 * `useBoard(pipelineId)` rodava SEMPRE, e os ramos de erro e de carregamento do
 * quadro vinham ANTES do teste de visão: a lista só aparecia depois que a
 * leitura do funil INTEIRO terminasse. Num funil migrado com milhares de
 * negócios é justamente essa leitura que leva 19 s e estoura o
 * `statement_timeout` — a aba que existe para não pagá-la estava atrás dela.
 *
 * ─── Por que o quadro NÃO é mockado aqui ────────────────────────────────────
 *
 * Os irmãos deste diretório dublam `useBoard` para montar a tela com o quadro
 * pronto. Aqui isso provaria a coisa errada: "não leu o quadro" tem de ser
 * medido no lugar onde a leitura ACONTECE — o `enabled` do React Query, dentro
 * de `useBoard` — e o que ela produz é uma chamada HTTP. Então o hook é o REAL
 * e o que se observa é a chamada (`/board`) que ele faz ou deixa de fazer, com
 * o quadro do caso de controle provando que o aparato mede (vacuidade: se o
 * quadro também não chamasse nada no caso do quadro, "não chamou" não diria
 * nada).
 *
 * Só o canal de realtime e a rede de segurança do quadro são dublados: os dois
 * são ligados pelo MESMO `enabled` da consulta e não têm o que medir aqui — mas
 * são observados, porque é `enabled: false` neles que mostra que a leitura cara
 * inteira parou, e não só a consulta.
 */

const { get, replace, push, canal, seguranca, busca } = vi.hoisted(() => ({
  get: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  canal: vi.fn(),
  seguranca: vi.fn(),
  busca: { atual: "" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => "/app/pipelines/p-1",
  // A query string corrente, e não uma constante: é a URL que diz a visão, e
  // `replace` a atualiza como o router de verdade (é o que faz o clique na aba
  // e o `?visao=lista` de um link caírem no mesmo estado).
  useSearchParams: () => new URLSearchParams(busca.atual),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opcoes: unknown) => {
    canal(opcoes);
    return { status: "SUBSCRIBED", ultimaEntrega: { current: null } };
  },
}));

vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: (opcoes: unknown) => {
    seguranca(opcoes);
    return { divergencias: 0, ultimaVerificacao: null };
  },
}));

vi.mock("@/components/kanban/KanbanBoard", () => ({
  KanbanBoard: () => <div data-testid="quadro" />,
}));
vi.mock("@/components/kanban/CalendarioDoFunil", () => ({
  CalendarioDoFunil: () => <div data-testid="calendario" />,
}));
vi.mock("@/components/kanban/FilterBar", () => ({
  FilterBar: ({ filters, onChange }: { filters: object; onChange: (f: object) => void }) => (
    <button
      type="button"
      data-testid="mudar-filtro"
      onClick={() => onChange({ ...filters, search: "novo" })}
    />
  ),
}));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
vi.mock("@/components/kanban/LeadDossier", () => ({ LeadDossier: () => null }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

/** A leitura leve do server component (#3172, item 4): funil e etapas, sem negócio. */
const FUNIL_LEVE = {
  id: "p-1",
  name: "Vendas",
  vocabulary: null,
  settings: {},
} as unknown as Pipeline;
const ETAPAS = [
  { id: "e-1", name: "Prospecção", position: 0, is_won: false, is_lost: false },
] as unknown as Stage[];

/** Um negócio SÓ no quadro e outro SÓ na página da lista: é assim que se vê de
 *  onde veio cada linha, mesmo que a chamada do quadro nem aconteça. */
const DO_QUADRO = { id: "l-quadro", title: "Negócio do quadro", stage_id: "e-1" };
const DA_LISTA = {
  id: "l-lista",
  title: "Negócio da lista",
  stage_id: "e-1",
  value_cents: 100_000,
  currency: "BRL",
  last_activity_at: null,
};

beforeEach(() => {
  get.mockReset();
  replace.mockReset();
  push.mockReset();
  canal.mockReset();
  seguranca.mockReset();
  busca.atual = "";
  get.mockImplementation(async (caminho: string) => {
    if (caminho.includes("/board")) {
      return { data: { pipeline: FUNIL_LEVE, stages: ETAPAS, leads: [DO_QUADRO] } };
    }
    if (caminho.includes("/leads?")) {
      return { data: [DA_LISTA], meta: { page: 1, per_page: 50, has_more: false } };
    }
    return {};
  });
  replace.mockImplementation((url: string) => {
    busca.atual = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  });
});

function montar() {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={cliente}>
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={[{ id: "p-1", name: "Vendas" }]}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />
    </QueryClientProvider>,
  );
}

/** As chamadas ao caminho dado — a régua de "leu o quadro" e "leu a página". */
const chamadas = (trecho: string) => get.mock.calls.filter(([c]) => String(c).includes(trecho));

describe("a aba Lista abre sem pagar a leitura do quadro", () => {
  it("⭐ `?visao=lista` abre a lista SEM nenhuma chamada ao quadro", async () => {
    busca.atual = "visao=lista";
    montar();

    // A lista está na tela: o efeito do item 4 é a lista aparecer sem esperar o
    // quadro — e não "aparecer mais rápido".
    expect(await screen.findByTestId("lista-do-funil")).toBeTruthy();
    // Ela é a página da rota paginada, com os negócios DELA.
    await waitFor(() => expect(chamadas("/leads?").length).toBeGreaterThan(0));
    expect(screen.getByText("Negócio da lista")).toBeTruthy();

    // ⭐ A PROVA: a leitura do quadro inteiro não saiu. Sem a mudança, este
    // `expect` é o que fica vermelho (a chamada ao quadro acontece sempre).
    expect(chamadas("/board")).toHaveLength(0);
    expect(screen.queryByText("Negócio do quadro")).toBeNull();
    // E o que acompanha a leitura cara vai junto: canal e rede de segurança.
    expect(canal).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(seguranca).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("o Quadro lê o quadro (controle: a régua acima mede mesmo)", async () => {
    montar();

    expect(await screen.findByTestId("quadro")).toBeTruthy();
    await waitFor(() => expect(chamadas("/board")).toHaveLength(1));
    expect(canal).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.queryByTestId("lista-do-funil")).toBeNull();
  });

  it("o Calendário continua lendo o quadro, como hoje", async () => {
    busca.atual = "visao=calendario";
    montar();

    expect(await screen.findByTestId("calendario")).toBeTruthy();
    await waitFor(() => expect(chamadas("/board")).toHaveLength(1));
  });

  it("clicar em Lista escreve a visão na URL, sem levar o filtro junto", async () => {
    busca.atual = "q=abc";
    montar();

    await userEvent.click(screen.getByTestId("visao-lista"));

    expect(replace).toHaveBeenLastCalledWith("/app/pipelines/p-1?q=abc&visao=lista", {
      scroll: false,
    });
    expect(await screen.findByTestId("lista-do-funil")).toBeTruthy();
  });

  it("a visão sobrevive à reescrita do filtro — digitar na busca não devolve o quadro", async () => {
    busca.atual = "visao=lista";
    montar();

    await screen.findByTestId("lista-do-funil");
    await userEvent.click(screen.getByTestId("mudar-filtro"));

    expect(replace).toHaveBeenLastCalledWith("/app/pipelines/p-1?q=novo&visao=lista", {
      scroll: false,
    });
    expect(screen.getByTestId("lista-do-funil")).toBeTruthy();
    expect(chamadas("/board")).toHaveLength(0);
  });
});
