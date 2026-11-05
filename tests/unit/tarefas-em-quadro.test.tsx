/**
 * TAREFAS EM QUADRO — a terceira visão da tela (#4028).
 *
 * O que este arquivo prende, e por que cada asserção existe:
 *
 *  1. A tela OFERECE a visão. Antes desta fatia, `modo` só conhecia
 *     `lista | calendario` e não havia botão nenhum de quadro — é o RED medido.
 *  2. Cada tarefa cai na coluna da sua situação, e arrastar grava a situação
 *     nova. O corpo do PATCH é o dobro da prova: ele carrega `status` e SÓ
 *     `status`, então o arrasto nunca reescreve título, prazo ou responsável —
 *     é o que impede a escrita de ZERAR dado em duas abas abertas.
 *  3. Tarefa com situação que a tela não conhece (coluna nova no banco, valor
 *     nulo de uma instalação antiga) NÃO desaparece: vai para "Sem situação".
 *     Quadro que perde cartão em silêncio é pior que quadro nenhum.
 *  4. A carga é LIMITADA e o limite viaja no fio. O quadro não pode pedir a
 *     base inteira: pede `limite=200`, e quando a resposta bate no teto a tela
 *     DIZ que está cortada, em vez de fingir que aquilo é tudo.
 *  5. Quem só lê não arrasta (o cartão nasce com o arrasto desligado) — a rota
 *     recusa de novo, mas a tela não convida ao gesto que vai dar 403.
 *  6. Lista e Calendário continuam como estavam: voltar do quadro para a lista
 *     não deixa a tela presa.
 *
 * O dnd é dublê pelo mesmo motivo do teste do quadro do funil: o `DropResult`
 * que o gesto do mouse e o do teclado produzem é o mesmo, e arrastar pixels no
 * jsdom não mede nada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SituacaoDaTarefa, Tarefa } from "@/lib/tarefas/tipos";

const dnd = vi.hoisted(() => ({
  onDragEnd: null as ((r: unknown) => void) | null,
  semArrasto: new Map<string, boolean>(),
  colunasSemSoltar: new Map<string, boolean>(),
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({
    onDragEnd,
    children,
  }: {
    onDragEnd: (r: unknown) => void;
    children: ReactNode;
  }) => {
    dnd.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Droppable: ({ droppableId, isDropDisabled, children }: any) => {
    dnd.colunasSemSoltar.set(droppableId, Boolean(isDropDisabled));
    return children(
      { innerRef: () => {}, droppableProps: {}, placeholder: null },
      { isDraggingOver: false },
    );
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Draggable: ({ draggableId, isDragDisabled, children }: any) => {
    dnd.semArrasto.set(draggableId, Boolean(isDragDisabled));
    return children(
      { innerRef: () => {}, draggableProps: {}, dragHandleProps: {} },
      { isDragging: false },
    );
  },
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-eu" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ isSuccess: true, data: [] }),
}));

import { TarefasClient } from "@/app/app/tasks/_components/TarefasClient";

const LIMITE_DO_QUADRO = 200;

function tarefa(over: Partial<Tarefa> & Pick<Tarefa, "id">): Tarefa {
  return {
    organization_id: "org-1",
    title: `Tarefa ${over.id}`,
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: null,
    contact_id: null,
    demanda_id: null,
    assigned_to: null,
    created_by: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    ...over,
  } as Tarefa;
}

const json = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** O que a rota devolve para a LISTA (sem `limite`) e para o QUADRO (com ele). */
let daLista: Tarefa[] = [];
let doQuadro: Tarefa[] = [];
/** Quando ligado, o PATCH fica pendente até `liberarOPatch()` — é assim que se
 *  mede o cartão mudando de coluna ANTES de o servidor responder. */
let postergarOPatch = false;
let liberarOPatch: (() => void) | null = null;
/** Simula a OUTRA ABA escrevendo por cima enquanto o nosso PATCH está no ar. */
let outraAbaEscreveu: SituacaoDaTarefa | null = null;

const idDaUrl = (url: string) => String(url).split("/").at(-1) ?? "";

const fetchEspiao = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "PATCH") {
    const corpo = JSON.parse(String(init.body)) as { status?: SituacaoDaTarefa };
    const aplica = () => {
      // O que fica GRAVADO é a última escrita: se a outra aba escreveu no meio,
      // o servidor devolve o valor dela, não o nosso.
      const efetiva = outraAbaEscreveu ?? corpo.status;
      if (efetiva) {
        doQuadro = doQuadro.map((t) => (t.id === idDaUrl(url) ? { ...t, status: efetiva } : t));
        daLista = daLista.map((t) => (t.id === idDaUrl(url) ? { ...t, status: efetiva } : t));
      }
      return json({ data: { task: { ...tarefa({ id: idDaUrl(url) }), ...corpo } } });
    };
    if (postergarOPatch) {
      return new Promise<Response>((res) => {
        liberarOPatch = () => res(aplica());
      });
    }
    return aplica();
  }
  const u = String(url);
  return json({ data: { tasks: u.includes(`limite=${LIMITE_DO_QUADRO}`) ? doQuadro : daLista } });
});

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  dnd.onDragEnd = null;
  dnd.semArrasto.clear();
  dnd.colunasSemSoltar.clear();
  fetchEspiao.mockClear();
  vi.stubGlobal("fetch", fetchEspiao);
  postergarOPatch = false;
  liberarOPatch = null;
  outraAbaEscreveu = null;
  daLista = [
    tarefa({ id: "t-1" }),
    tarefa({ id: "t-2", status: "in_progress" }),
    tarefa({ id: "t-3", status: "done" }),
    tarefa({ id: "t-4", status: "cancelled" }),
  ];
  doQuadro = [...daLista];
});

afterEach(() => vi.unstubAllGlobals());

function renderTela(podeEditar = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TarefasClient podeEditar={podeEditar} />
    </QueryClientProvider>,
  );
}

async function abrirQuadro(podeEditar = true) {
  renderTela(podeEditar);
  await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Quadro" }));
  const quadro = await screen.findByTestId("tarefas-quadro");
  await waitFor(() => expect(dnd.onDragEnd).not.toBeNull());
  return quadro;
}

async function arrastar(origem: SituacaoDaTarefa, destino: string, id = "t-1") {
  await waitFor(() => expect(dnd.onDragEnd).not.toBeNull());
  await act(async () => {
    dnd.onDragEnd?.({
      draggableId: id,
      source: { droppableId: origem, index: 0 },
      destination: { droppableId: destino, index: 0 },
      reason: "DROP",
      type: "DEFAULT",
      mode: "FLUID",
    });
  });
}

const urls = () => fetchEspiao.mock.calls.map(([url]) => String(url));
const patches = () =>
  fetchEspiao.mock.calls.filter(([, init]) => init?.method === "PATCH") as Array<
    [string, RequestInit]
  >;

describe("Tarefas — visão em quadro", () => {
  it("⭐ a tela oferece a terceira visão, ao lado de Lista e Calendário", async () => {
    renderTela();
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "Lista" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Calendário" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quadro" })).toBeTruthy();
  });

  it("o quadro mostra uma coluna por situação, com cada tarefa na sua", async () => {
    const quadro = await abrirQuadro();

    expect(within(quadro).getByTestId("tarefas-coluna-pending")).toBeTruthy();
    expect(within(quadro).getByTestId("tarefas-coluna-in_progress")).toBeTruthy();
    expect(within(quadro).getByTestId("tarefas-coluna-done")).toBeTruthy();
    expect(within(quadro).getByTestId("tarefas-coluna-cancelled")).toBeTruthy();

    expect(
      within(within(quadro).getByTestId("tarefas-coluna-pending")).getByTestId(
        "tarefa-no-quadro-t-1",
      ),
    ).toBeTruthy();
    expect(
      within(within(quadro).getByTestId("tarefas-coluna-in_progress")).getByTestId(
        "tarefa-no-quadro-t-2",
      ),
    ).toBeTruthy();
    expect(
      within(within(quadro).getByTestId("tarefas-coluna-done")).getByTestId("tarefa-no-quadro-t-3"),
    ).toBeTruthy();
  });

  it("⭐ arrastar o cartão grava a situação nova — e SÓ ela", async () => {
    doQuadro = [tarefa({ id: "t-1", status: "pending", title: "Ligar de volta" })];
    await abrirQuadro();

    await arrastar("pending", "in_progress");

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [url, init] = patches()[0]!;
    expect(url).toBe("/api/v1/tasks/t-1");
    // A ESCRITA É PARCIAL, de propósito: duas abas moverem a mesma tarefa
    // resolvem por "última escrita vence", e nada além da situação é tocado —
    // nem título, nem prazo, nem responsável. Mandar o objeto inteiro aqui
    // zeraria o que a outra aba acabou de salvar.
    expect(JSON.parse(String(init.body))).toEqual({ status: "in_progress" });
  });

  it("a tarefa que muda de coluna não some enquanto o servidor responde", async () => {
    doQuadro = [tarefa({ id: "t-1", status: "pending" })];
    postergarOPatch = true;
    await abrirQuadro();

    await arrastar("pending", "done");

    // O PATCH ainda está no ar e o cartão JÁ está na coluna de destino — sem
    // isso o gesto pareceria não ter funcionado até o refetch chegar.
    expect(
      within(screen.getByTestId("tarefas-coluna-done")).getByTestId("tarefa-no-quadro-t-1"),
    ).toBeTruthy();

    await act(async () => {
      liberarOPatch?.();
    });
    await waitFor(() => expect(patches()).toHaveLength(1));
  });

  it("⭐ duas abas na mesma tarefa: a última escrita vence, e a tela mostra a do servidor", async () => {
    doQuadro = [tarefa({ id: "t-1", status: "pending" })];
    postergarOPatch = true;
    // A outra aba move a MESMA tarefa enquanto o nosso PATCH está no ar.
    outraAbaEscreveu = "cancelled";
    await abrirQuadro();

    await arrastar("pending", "done");
    await act(async () => {
      liberarOPatch?.();
    });

    // Nada foi zerado (o corpo do PATCH leva só `status` — provado acima), e a
    // tela NÃO insiste na nossa coluna: quem manda é o que o servidor devolveu.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("tarefas-coluna-cancelled")).getByTestId("tarefa-no-quadro-t-1"),
      ).toBeTruthy(),
    );
    expect(
      within(screen.getByTestId("tarefas-coluna-done")).queryByTestId("tarefa-no-quadro-t-1"),
    ).toBeNull();
  });

  it("⭐ tarefa com situação desconhecida não desaparece: cai na coluna própria", async () => {
    // O CHECK do banco só conhece quatro valores, mas uma instalação que
    // recebeu uma situação nova por migration, ou um `null` de dado antigo,
    // chegaria aqui. Sumir é o único desfecho inaceitável.
    doQuadro = [
      tarefa({ id: "t-1" }),
      { ...tarefa({ id: "t-9" }), status: "em_revisao" as SituacaoDaTarefa },
    ];
    const quadro = await abrirQuadro();

    const semSituacao = within(quadro).getByTestId("tarefas-coluna-sem_situacao");
    expect(within(semSituacao).getByTestId("tarefa-no-quadro-t-9")).toBeTruthy();
    // E a coluna só existe porque há cartão nela: quadro com cinco colunas
    // fixas mentiria sobre o vocabulário do produto.
    expect(within(quadro).getByTestId("tarefas-coluna-pending")).toBeTruthy();
  });

  it("⭐ o quadro pede carga LIMITADA — não a base inteira", async () => {
    renderTela();
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
    const antes = urls().length;

    await userEvent.click(screen.getByRole("button", { name: "Quadro" }));
    await screen.findByTestId("tarefas-quadro");

    // Abrir o quadro faz UMA busca — e ela carrega o teto de 200 no fio. A
    // lista, que já estava carregada, não é pedida de novo (nem com o teto
    // dela, nem sem teto): o quadro não soma a base inteira à carga da tela.
    const depois = urls().slice(antes);
    expect(depois).toHaveLength(1);
    expect(depois[0]).toContain(`limite=${LIMITE_DO_QUADRO}`);
    // E o quadro pede TODAS as situações: as colunas são elas, então não há
    // `status=` nem `aberto=` na busca — filtrar por uma deixaria três colunas
    // vazias ao lado da escolhida.
    expect(depois[0]).not.toContain("aberto=");
    expect(depois[0]).not.toContain("status=");
  });

  it("quando a resposta bate no limite, a tela avisa que está cortada", async () => {
    doQuadro = Array.from({ length: LIMITE_DO_QUADRO }, (_, i) => tarefa({ id: `t-${i}` }));
    await abrirQuadro();

    expect(
      screen.getByText(
        "Só as primeiras tarefas aparecem aqui — use os filtros para ver as demais.",
      ),
    ).toBeTruthy();
  });

  it("com poucas tarefas não há aviso de corte", async () => {
    await abrirQuadro();

    expect(
      screen.queryByText(
        "Só as primeiras tarefas aparecem aqui — use os filtros para ver as demais.",
      ),
    ).toBeNull();
  });

  it("⭐ quem só lê não arrasta — o cartão nasce sem o gesto", async () => {
    await abrirQuadro(false);

    expect(dnd.semArrasto.get("t-1")).toBe(true);
    expect(dnd.colunasSemSoltar.get("pending")).toBe(true);

    // E mesmo que um gesto escapasse, a tela não escreve por conta própria.
    await arrastar("pending", "done");
    expect(patches()).toHaveLength(0);
  });

  it("quem pode editar arrasta", async () => {
    await abrirQuadro(true);

    expect(dnd.semArrasto.get("t-1")).toBe(false);
    expect(dnd.colunasSemSoltar.get("pending")).toBe(false);
  });

  it("no quadro o filtro de situação não aparece: as colunas SÃO as situações", async () => {
    renderTela();
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
    expect(screen.getByRole("combobox", { name: "Situação" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Quadro" }));
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Situação" })).toBeNull());
  });
});

describe("Tarefas — Lista e Calendário continuam como estavam", () => {
  it("⭐ a tela abre na Lista, e voltar do Quadro devolve a Lista", async () => {
    renderTela();
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());

    const lista = await screen.findByTestId("tarefas-lista");
    expect(lista.className).not.toContain("md:hidden");
    // O controle positivo: a lista usa uma carga só, sem o limite do quadro.
    expect(urls().every((u) => !u.includes(`limite=${LIMITE_DO_QUADRO}`))).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Quadro" }));
    await screen.findByTestId("tarefas-quadro");

    await userEvent.click(screen.getByRole("button", { name: "Lista" }));
    await waitFor(() =>
      expect(screen.getByTestId("tarefas-lista").className).not.toContain("md:hidden"),
    );
    expect(screen.queryByTestId("tarefas-quadro")).toBeNull();
  });

  it("o calendário continua abrindo pelo seu botão", async () => {
    renderTela();
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Calendário" }));
    const calendario = await screen.findByTestId("tarefas-calendario");
    expect(calendario.className).toContain("md:block");
    expect(screen.getByTestId("tarefas-lista").className).toContain("md:hidden");
  });
});
describe("Tarefas — o quadro segue o servidor depois de mover", () => {
  it("a tarefa que VOLTA para a situação de origem não fica presa na coluna antiga", async () => {
    doQuadro = [tarefa({ id: "t-1", status: "pending" }), tarefa({ id: "t-2", status: "pending" })];
    await abrirQuadro();

    await arrastar("pending", "done", "t-1");
    await waitFor(() =>
      expect(within(screen.getByTestId("tarefas-coluna-done")).getByTestId("tarefa-no-quadro-t-1")).toBeTruthy(),
    );

    // Pelo formulário (ou outra aba), a t-1 volta a "pending" no servidor.
    doQuadro = doQuadro.map((t) => (t.id === "t-1" ? { ...t, status: "pending" } : t));
    // Qualquer escrita refaz a busca: arrasta a t-2.
    await arrastar("pending", "in_progress", "t-2");
    await waitFor(() =>
      expect(within(screen.getByTestId("tarefas-coluna-in_progress")).getByTestId("tarefa-no-quadro-t-2")).toBeTruthy(),
    );
    await waitFor(() => expect(fetchEspiao.mock.calls.filter(([u, i]) => !i && String(u).includes("limite=200")).length).toBeGreaterThanOrEqual(3));

    expect(within(screen.getByTestId("tarefas-coluna-pending")).queryByTestId("tarefa-no-quadro-t-1")).not.toBeNull();
  });
});
