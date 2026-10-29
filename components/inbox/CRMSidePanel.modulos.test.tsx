/**
 * A LATERAL DO INBOX, DO CLIQUE AO PRIMEIRO PAINT (#3008).
 *
 * ─── O que a issue pede, medido na TELA ─────────────────────────────────────
 *
 *   1. **CONTROLE — quem nunca configurou vê a lateral de hoje.** O painel é
 *      montado sem preferência (o caso do usuário novo) e a lista de módulos no
 *      DOM tem de ser, na ordem, a de `MODULOS_DA_LATERAL`. É o controle do
 *      "nada muda para quem não pediu".
 *   2. **Desligar um módulo o remove da lateral**, os outros continuam, e a
 *      escolha sobrevive a RECARREGAR — aqui, desmontar e montar de novo com o
 *      que o servidor passou a devolver (é o caminho de
 *      `app/app/inbox/page.tsx` -> `carregarModulosDaLateral`).
 *   3. **Reordenar persiste** — pelo arrasto (`onDragEnd` do
 *      `@hello-pangea/dnd`, capturado pelo dublê do pacote, como em
 *      `tests/unit/resposta-rapida-reordenar.test.tsx`) e pelos botões, que
 *      existem para quem não arrasta.
 *   4. **Restaurar padrão** volta a lista de hoje.
 *   5. **Falha de gravação não mente**: a lateral continua como estava.
 *
 * O que este arquivo NÃO prova, e quem prova: a gravação por pessoa (A não
 * afeta B) está em `app/actions/inbox/modulosDaLateral.test.ts`; a régua de
 * normalização, em `lib/inbox/modulos-da-lateral.test.ts`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import {
  MODULOS_DA_LATERAL,
  normalizarModulos,
  type ModuloDaLateral,
} from "@/lib/inbox/modulos-da-lateral";

const ORG = "00000000-0000-4000-8000-0000000005aa";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "cv-1";

/** A lateral de HOJE, escrita à mão: é o controle do "usuário novo". */
const LATERAL_DE_HOJE = [
  "contato",
  "tags-do-contato",
  "carteira",
  "anuncio",
  "perfil-enriquecido",
  "tags-da-conversa",
  "demandas",
  "tarefas",
  "followup",
  "memoria",
  "roteiros",
  "leads",
  "compras",
  "pedidos",
  "atividade",
  "acervo",
];

/**
 * O "servidor" da preferência: o que a action gravou e o que a próxima carga
 * do Inbox passaria como `modulosIniciais`. Uma variável só, com a MESMA régua
 * de normalização do servidor — é o que faz o "sobrevive a recarregar" ser uma
 * prova, e não uma afirmação.
 */
const h = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  salvar: vi.fn(),
  capturado: { onDragEnd: null as ((r: unknown) => void) | null },
  gravado: null as null | ModuloDaLateral[],
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-eu", role: "manager", support: null, is_platform_admin: false },
    activeOrg: { orgId: ORG, name: "Org", role: "manager" },
  }),
  usePermission: () => true,
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => h.get(...args),
    patch: (...args: unknown[]) => h.patch(...args),
    post: vi.fn(),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => <div data-testid="roteiros" /> }));
// O `CartaoDaCarteira` traz fetch próprio e não é o alvo: um bloco qualquer,
// com o testid que o painel já usa para ele.
vi.mock("@/components/contacts/CartaoDaCarteira", () => ({
  CartaoDaCarteira: () => <div data-testid="carteira-do-contato" />,
}));

/**
 * O arrasto não é medido pelo pacote (o jsdom não mede layout): o dublê captura
 * o `onDragEnd` que o diálogo registra e o teste o chama, que é o MESMO caminho
 * de `tests/unit/resposta-rapida-reordenar.test.tsx`.
 */
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ onDragEnd, children }: { onDragEnd: (r: unknown) => void; children: ReactNode }) => {
    h.capturado.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  Droppable: ({ children }: { children: (p: Record<string, unknown>) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
  Draggable: ({ children }: { children: (p: Record<string, unknown>, s: Record<string, unknown>) => ReactNode }) =>
    children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));

/** A action de gravar, pela MESMA régua do servidor. */
vi.mock("@/app/actions/inbox/modulosDaLateral", () => ({
  salvarModulosDaLateral: (...args: unknown[]) => h.salvar(...args),
}));

import { CRMSidePanel } from "./CRMSidePanel";

const conversa = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: CONTATO,
  channel_session_id: "cs-1",
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  bot_silenced_until: null,
  service_revision: 1,
  current_demanda_id: null,
  last_inbound_at: "2026-09-15T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: null,
  contacts: {
    id: CONTATO,
    display_name: "Fulana",
    name: null,
    phone_number: "5511999",
    tags: [],
    is_anonymized: false,
  },
} as unknown as ConversationWithContact;

const resumo = {
  data: { leads: [], orders: [], activities: [], demandas: [], fatos: [], historico: [] },
};

h.get.mockImplementation(async (url?: string) => {
  const bruto = url ?? "";
  if (bruto.includes("crm-summary")) return resumo;
  if (bruto.includes("team/assignable")) return { data: [] };
  return { data: [] };
});

/** A action devolve o que GRAVOU — a lateral passa a ser essa. */
h.salvar.mockImplementation(async (entrada: ModuloDaLateral[]) => {
  const modulos = normalizarModulos(entrada);
  h.gravado = modulos;
  return { ok: true, modulos };
});

beforeEach(() => {
  vi.clearAllMocks();
  h.capturado.onDragEnd = null;
  h.gravado = null;
});

/**
 * Monta o painel como o servidor o entrega: `modulosIniciais` é o que a última
 * gravação deixou. Sem gravação (usuário novo), `undefined` — o padrão.
 */
function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CRMSidePanel conversation={conversa} modulosIniciais={h.gravado ?? undefined} />
    </QueryClientProvider>,
  );
}

/**
 * "Recarregar a tela": desmonta o painel e monta outro com o que o servidor
 * passou a devolver. É o caminho real — `page.tsx` lê `carregarModulosDaLateral`
 * no servidor e passa como `modulosIniciais` —, então o que se mede aqui é que a
 * preferência NÃO mora no estado local de quem clicou.
 */
function recarregar(tela: ReturnType<typeof montar>) {
  tela.unmount();
  return montar();
}

/** Os módulos que a lateral DESENHOU, na ordem do DOM. */
const modulosNaTela = () =>
  Array.from(document.querySelectorAll("[data-modulo]")).map((el) => el.getAttribute("data-modulo"));

const abrirDialogo = async () => {
  const u = userEvent.setup();
  await u.click(screen.getByRole("button", { name: "Personalizar lateral" }));
  const dialogo = await screen.findByRole("dialog");
  return { u, dialogo };
};

const interruptor = (dialogo: HTMLElement, id: string) =>
  within(within(dialogo).getByTestId(`modulo-${id}`)).getByRole("switch") as HTMLButtonElement;

describe("#3008 — CONTROLE: usuário novo vê a lateral de hoje", () => {
  it("sem preferência gravada, todos os módulos aparecem e na ordem de hoje", async () => {
    montar();
    await screen.findByTestId("inbox-demandas");

    expect(modulosNaTela()).toEqual(LATERAL_DE_HOJE);
    expect(modulosNaTela()).toHaveLength(MODULOS_DA_LATERAL.length);
  });

  it("os blocos continuam sendo os de antes: contato, demandas, atividade, acervo", async () => {
    montar();

    await screen.findByTestId("inbox-contato");
    expect(screen.getByTestId("inbox-demandas")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-memoria")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-campos-lead")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-pedidos")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-atividade")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-bloco-acervo")).toBeInTheDocument();
    // Os títulos que o operador conhece continuam os mesmos.
    expect(screen.getByText("Demandas abertas")).toBeInTheDocument();
    expect(screen.getByText("Memória do contato")).toBeInTheDocument();
  });
});

describe("#3008 — desligar um módulo o tira da lateral, e a escolha sobrevive", () => {
  it("módulo desligado não é desenhado; os outros continuam lá", async () => {
    h.gravado = normalizarModulos([
      { id: "acervo", visivel: false },
      { id: "contato", visivel: true },
    ]);
    montar();

    await screen.findByTestId("inbox-contato");
    expect(screen.queryByTestId("inbox-bloco-acervo")).toBeNull();
    expect(document.querySelector('[data-modulo="acervo"]')).toBeNull();
    // O vizinho e os distantes seguem: desligar um não desliga a fila.
    expect(document.querySelector('[data-modulo="atividade"]')).not.toBeNull();
    expect(screen.getByTestId("inbox-demandas")).toBeInTheDocument();
  });

  it("desligar pela TELA e salvar: o módulo some agora E depois de recarregar", async () => {
    const telaInicial = montar();
    await screen.findByTestId("inbox-bloco-acervo");
    const { u, dialogo } = await abrirDialogo();

    await u.click(interruptor(dialogo, "acervo"));
    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    const enviado = h.salvar.mock.calls[0]![0] as ModuloDaLateral[];
    expect(enviado.find((m) => m.id === "acervo")).toEqual({ id: "acervo", visivel: false });
    // A lateral inteira continua no que foi gravado: esconder não apaga.
    expect(enviado).toHaveLength(MODULOS_DA_LATERAL.length);

    // 1) o clique tem efeito IMEDIATO (o "Salvar" devolve o gravado)
    await waitFor(() => expect(screen.queryByTestId("inbox-bloco-acervo")).toBeNull());

    // 2) e "RECARREGAR" — desmontar e montar com o que o servidor passou a
    //    devolver — mantém a escolha. É a prova de que ela não mora só no estado
    //    local de quem clicou.
    recarregar(telaInicial);
    await screen.findByTestId("inbox-contato");
    expect(screen.queryByTestId("inbox-bloco-acervo")).toBeNull();
    expect(modulosNaTela()).not.toContain("acervo");
    expect(modulosNaTela()).toHaveLength(MODULOS_DA_LATERAL.length - 1);
  });

  it("Restaurar padrão devolve a lateral de hoje — todos os módulos, na ordem original", async () => {
    h.gravado = normalizarModulos([{ id: "acervo", visivel: false }]);
    montar();
    await screen.findByTestId("inbox-contato");
    expect(modulosNaTela()).not.toEqual(LATERAL_DE_HOJE);

    const { u, dialogo } = await abrirDialogo();
    await u.click(within(dialogo).getByRole("button", { name: "Restaurar padrão" }));
    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    expect(h.salvar.mock.calls[0]![0]).toEqual(
      LATERAL_DE_HOJE.map((id) => ({ id, visivel: true })),
    );
  });
});

describe("#3008 — reordenar persiste", () => {
  it("a ordem gravada desenha a lateral na ordem escolhida", async () => {
    h.gravado = normalizarModulos([
      { id: "acervo", visivel: true },
      { id: "atividade", visivel: true },
      { id: "pedidos", visivel: true },
    ]);
    montar();

    await screen.findByTestId("inbox-contato");
    const naTela = modulosNaTela();
    expect(naTela.slice(0, 3)).toEqual(["acervo", "atividade", "pedidos"]);
    // Nada foi perdido na ida e volta pelo metadata.
    expect(naTela).toHaveLength(MODULOS_DA_LATERAL.length);
    expect(new Set(naTela).size).toBe(MODULOS_DA_LATERAL.length);
  });

  it("o ARRASTO manda a ordem nova e a lateral redesenha nela", async () => {
    montar();
    await screen.findByTestId("inbox-bloco-acervo");

    const { u, dialogo } = await abrirDialogo();
    await waitFor(() => expect(h.capturado.onDragEnd).not.toBeNull());

    // "acervo" (último) é solto no topo: o gesto do operador, não um atalho.
    await act(async () => {
      h.capturado.onDragEnd?.({
        draggableId: "acervo",
        source: { droppableId: "modulos-da-lateral", index: LATERAL_DE_HOJE.length - 1 },
        destination: { droppableId: "modulos-da-lateral", index: 0 },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });

    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));

    const enviado = h.salvar.mock.calls[0]![0] as ModuloDaLateral[];
    expect(enviado[0]).toEqual({ id: "acervo", visivel: true });
    expect(enviado).toHaveLength(MODULOS_DA_LATERAL.length);
    expect(new Set(enviado.map((m) => m.id)).size).toBe(MODULOS_DA_LATERAL.length);
    expect(enviado.map((m) => m.id)).not.toEqual(LATERAL_DE_HOJE);

    // E a lateral passa a desenhar a nova ordem, sem recarregar a página.
    await waitFor(() => expect(modulosNaTela()[0]).toBe("acervo"));
  });

  it("os botões movem para quem não arrasta — subir o último módulo o põe em primeiro", async () => {
    montar();
    await screen.findByTestId("inbox-bloco-acervo");

    const { u, dialogo } = await abrirDialogo();
    const subir = within(within(dialogo).getByTestId("modulo-acervo")).getByRole("button", {
      name: /Mover para cima/,
    });
    // Um clique por posição: `acervo` é o último de dezesseis.
    for (let i = 0; i < LATERAL_DE_HOJE.length - 1; i += 1) {
      await u.click(within(within(dialogo).getByTestId("modulo-acervo")).getByRole("button", { name: /Mover para cima/ }));
    }
    expect(subir).toBeInTheDocument();

    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    expect((h.salvar.mock.calls[0]![0] as ModuloDaLateral[])[0]).toEqual({
      id: "acervo",
      visivel: true,
    });
  });

  it("cancelar não grava nem muda a lateral", async () => {
    montar();
    await screen.findByTestId("inbox-bloco-acervo");

    const { u, dialogo } = await abrirDialogo();
    await u.click(interruptor(dialogo, "acervo"));
    await u.click(within(dialogo).getByRole("button", { name: "Cancelar" }));

    expect(h.salvar).not.toHaveBeenCalled();
    expect(modulosNaTela()).toEqual(LATERAL_DE_HOJE);
    expect(screen.getByTestId("inbox-bloco-acervo")).toBeInTheDocument();
  });
});

describe("#3008 — falha de gravação não mente para quem configurou", () => {
  it("a action recusando deixa a lateral como estava e avisa", async () => {
    h.salvar.mockResolvedValueOnce({ ok: false, erro: "falha" });
    montar();
    await screen.findByTestId("inbox-bloco-acervo");

    const { u, dialogo } = await abrirDialogo();
    await u.click(interruptor(dialogo, "acervo"));
    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    // Nada de otimismo: o módulo continua na lateral, porque o servidor não
    // gravou. Sumir na tela e voltar no próximo carregamento é o defeito.
    expect(screen.getByTestId("inbox-bloco-acervo")).toBeInTheDocument();
    expect(modulosNaTela()).toEqual(LATERAL_DE_HOJE);
  });
});

/**
 * (g) DA PROVA PELA TELA: no celular a lateral mora num `Sheet`, e a faixa
 * `sticky` da engrenagem cobria o X de fechar — `document.elementFromPoint` no
 * centro do X devolvia a faixa, e o toque no X não fechava a gaveta.
 *
 * O jsdom não calcula empilhamento, então este caso mede a REGRA que decide o
 * empilhamento: o X e a faixa são posicionados no mesmo contexto (o conteúdo
 * do Sheet), o X vem ANTES no DOM, então só um `z-index` estritamente maior
 * põe o X por cima. A medida em pixel (elementFromPoint) é a da prova (g).
 */
describe("#3008 — no celular, a faixa da engrenagem não cobre o X do Sheet", () => {
  const zIndex = (el: Element) => Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(el.className)?.[1] ?? 0);

  it("o X de fechar fica acima da faixa sticky, montado como no InboxLayout", async () => {
    const { Sheet, SheetContent, SheetTitle } = await import("@/components/ui/sheet");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Sheet open>
          <SheetContent side="right" className="w-[min(22rem,90vw)] overflow-y-auto p-0">
            <SheetTitle className="sr-only">Ficha do contato</SheetTitle>
            <CRMSidePanel conversation={conversa} />
          </SheetContent>
        </Sheet>
      </QueryClientProvider>,
    );

    const faixa = await screen.findByTestId("inbox-cabecalho-do-painel");
    const fechar = screen.getByRole("button", { name: "Fechar" });

    expect(zIndex(faixa)).toBeGreaterThan(0);
    expect(zIndex(fechar)).toBeGreaterThan(zIndex(faixa));
  });
});
