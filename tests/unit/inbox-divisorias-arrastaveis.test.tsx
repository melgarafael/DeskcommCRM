import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS DIVISÓRIAS DO INBOX (#2579) — a regra PURA e a alça na tela.
 *
 * Duas camadas, duas garantias:
 *
 *   1. `lib/inbox/larguras-do-inbox.ts` é quem decide o valor. Os testes de
 *      função prendem o que não pode mudar: limite próprio (lista 240–520,
 *      ficha 260–560), o piso da conversa de 420px apertando o TETO de quem
 *      está do lado, a memória separada por faixa (notebook e monitor não
 *      brigam pela mesma chave) e o passo da seta.
 *
 *   2. O layout é quem entrega isso ao atendente: duas alças com
 *      `role=separator` a partir do `md`, nenhuma no celular, `aria-valuenow`
 *      vivo, persistência no `localStorage` e duplo clique voltando ao padrão.
 *
 * O que a tela lê de navegador está medido aqui, não presumido: `innerWidth`
 * escolhe a faixa, `getBoundingClientRect` dá a largura da grade e o
 * `pointerMove` acontece de verdade sobre a janela — é o mesmo caminho que o
 * ponteiro do atendente percorre.
 */

const { ORG } = vi.hoisted(() => ({ ORG: "00000000-0000-4000-8000-0000000005aa" }));

const get = vi.fn(async (url?: string): Promise<unknown> => {
  const bruto = url ?? "";
  if (bruto.startsWith("/api/v1/conversations?")) return new Promise(() => {});
  if (bruto === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({
  useConversationsRealtime: () => ({
    data: { pages: [{ data: [] }] },
    realtimeStatus: "ok",
    seguranca: { divergencias: 0 },
  }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";
import {
  CONVERSA_MINIMA,
  LIMITES_FICHA,
  LIMITES_LISTA,
  PASSO_TECLADO,
  chaveDaFaixa,
  faixaDaLargura,
  gravarLarguras,
  lerLarguras,
  moverPorSeta,
  resolverLarguras,
  type StorageLeve,
} from "@/lib/inbox/larguras-do-inbox";

const CHAVE_XL = "inbox:divisorias:xl";

/** Storage em memória: mesma semântica, sem depender do jsdom. */
function storageFalso(inicial: Record<string, string> = {}): StorageLeve & {
  dados: Map<string, string>;
} {
  const dados = new Map(Object.entries(inicial));
  return {
    dados,
    getItem: (chave) => dados.get(chave) ?? null,
    setItem: (chave, valor) => void dados.set(chave, valor),
    removeItem: (chave) => void dados.delete(chave),
  };
}

describe("a regra pura — limites, piso da conversa e memória por faixa", () => {
  it("prende cada coluna no seu próprio limite, arredondando o que vier do ponteiro", () => {
    // Além do teto, mesmo com espaço de sobra na grade.
    expect(
      resolverLarguras({ lista: 900, ficha: 300, larguraContainer: 2000, temFicha: true }).lista,
    ).toBe(LIMITES_LISTA.max);
    expect(
      resolverLarguras({ lista: 300, ficha: 9999, larguraContainer: 2000, temFicha: true }).ficha,
    ).toBe(LIMITES_FICHA.max);
    // Abaixo do piso, inclusive com fração do zoom do navegador.
    expect(
      resolverLarguras({ lista: 12.7, ficha: 100, larguraContainer: 2000, temFicha: true }),
    ).toEqual({ lista: LIMITES_LISTA.min, ficha: LIMITES_FICHA.min });
    // Valor não numérico não vira largura de coluna.
    expect(
      resolverLarguras({ lista: Number.NaN, ficha: 300, larguraContainer: 2000, temFicha: true })
        .lista,
    ).toBe(LIMITES_LISTA.min);
  });

  it("o piso da conversa aperta o teto das colunas e nunca o piso delas", () => {
    // Grade de 1040 (1280 menos a navegação e o padding, medido no layout):
    // lista 520 + ficha 296 deixaria 224px de conversa — o teto cede até 324.
    const apertado = resolverLarguras({
      lista: 520,
      ficha: 296,
      larguraContainer: 1040,
      temFicha: true,
    });
    expect(apertado).toEqual({ lista: 324, ficha: 296 });
    expect(1040 - apertado.lista - apertado.ficha).toBe(CONVERSA_MINIMA);

    // Mesmo cedendo, a lista não passa do próprio piso de 240.
    const estreita = resolverLarguras({
      lista: 520,
      ficha: 300,
      larguraContainer: 700,
      temFicha: true,
    });
    expect(estreita.lista).toBe(LIMITES_LISTA.min);
    expect(estreita.ficha).toBe(LIMITES_FICHA.min);

    // Janela estreita demais até para os três mínimos: o piso desliga em vez
    // de estourar o layout — e a lista segue valendo 240, nunca negativo.
    const miuda = resolverLarguras({
      lista: 520,
      ficha: 300,
      larguraContainer: 480,
      temFicha: false,
    });
    expect(miuda).toEqual({ lista: LIMITES_LISTA.min, ficha: 300 });
  });

  it("sem medida da grade (largura 0) só valem os limites próprios", () => {
    expect(
      resolverLarguras({ lista: 900, ficha: 100, larguraContainer: 0, temFicha: true }),
    ).toEqual({ lista: LIMITES_LISTA.max, ficha: LIMITES_FICHA.min });
  });

  it("grava e lê POR FAIXA: notebook e monitor grande não brigam pela mesma chave", () => {
    const storage = storageFalso();
    gravarLarguras(storage, "md", { lista: 500, ficha: 300 });
    gravarLarguras(storage, "2xl", { lista: 340, ficha: 400 });

    expect(chaveDaFaixa("md")).toBe("inbox:divisorias:md");
    expect(lerLarguras(storage, "md")).toEqual({ lista: 500, ficha: 300 });
    expect(lerLarguras(storage, "2xl")).toEqual({ lista: 340, ficha: 400 });
    // A faixa sem nada salvo devolve `null` — o layout interpreta como CSS.
    expect(lerLarguras(storage, "xl")).toBeNull();
    // Duas faixas convivendo: mexer numa não apaga a outra.
    expect(storage.dados.size).toBe(2);
  });

  it("chave corrompida, tipo errado ou fora dos limites não entra sem tratamento", () => {
    expect(lerLarguras(storageFalso({ "inbox:divisorias:xl": "{quebrado" }), "xl")).toBeNull();
    expect(
      lerLarguras(storageFalso({ "inbox:divisorias:xl": '{"lista":"500","ficha":300}' }), "xl"),
    ).toBeNull();
    expect(
      lerLarguras(storageFalso({ "inbox:divisorias:xl": '{"lista":100,"ficha":50}' }), "xl"),
    ).toEqual({ lista: LIMITES_LISTA.min, ficha: LIMITES_FICHA.min });
    expect(lerLarguras(null, "xl")).toBeNull();
  });

  it("restaurar o padrão apaga a chave da faixa", () => {
    const storage = storageFalso();
    gravarLarguras(storage, "xl", { lista: 400, ficha: 300 });
    expect(lerLarguras(storage, "xl")).not.toBeNull();

    gravarLarguras(storage, "xl", null);
    expect(lerLarguras(storage, "xl")).toBeNull();
    // O que a falha de escrita não pode quebrar: gravar em storage que lança
    // (quota cheia) é silencioso, o ajuste continua valendo na sessão.
    expect(() =>
      gravarLarguras(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
          removeItem: () => {},
        },
        "xl",
        { lista: 400, ficha: 300 },
      ),
    ).not.toThrow();
  });

  it("a seta move a divisória no passo e trava nos limites", () => {
    expect(moverPorSeta("lista", 300, "ArrowRight")).toBe(300 + PASSO_TECLADO);
    expect(moverPorSeta("lista", 300, "ArrowLeft")).toBe(300 - PASSO_TECLADO);
    expect(moverPorSeta("ficha", 300, "ArrowRight")).toBe(300 - PASSO_TECLADO);
    // Travado no limite: a tecla não passa pano.
    expect(moverPorSeta("lista", LIMITES_LISTA.max, "ArrowRight")).toBe(LIMITES_LISTA.max);
    expect(moverPorSeta("lista", LIMITES_LISTA.min, "ArrowLeft")).toBe(LIMITES_LISTA.min);
    expect(moverPorSeta("ficha", LIMITES_FICHA.max, "ArrowLeft")).toBe(LIMITES_FICHA.max);
    // Tecla que não ajusta largura devolve `null` (o componente não a come).
    expect(moverPorSeta("lista", 300, "Enter")).toBeNull();
    expect(moverPorSeta("lista", 300, "ArrowUp")).toBeNull();
  });

  it("a faixa segue o breakpoint do Tailwind e some abaixo do md", () => {
    expect(faixaDaLargura(1600)?.id).toBe("2xl");
    expect(faixaDaLargura(1440)?.id).toBe("xl");
    expect(faixaDaLargura(1024)?.id).toBe("md");
    expect(faixaDaLargura(767)).toBeNull();
    expect(faixaDaLargura(0)).toBeNull();
    expect(faixaDaLargura(Number.NaN)).toBeNull();
  });
});

/* ─── A alça na tela ──────────────────────────────────────────────────── */

/** Largura da grade devolvida pelo `getBoundingClientRect` de todo elemento. */
let larguraGrade = 1040;

function janelaEm(largura: number): void {
  Object.defineProperty(window, "innerWidth", { value: largura, configurable: true, writable: true });
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>,
  );
}

function grade(): HTMLElement {
  const principal = alcaAgora(0);
  if (!principal.parentElement) throw new Error("a grade não renderizou");
  return principal.parentElement;
}

/** A alça `indice` (0 = lista, 1 = ficha). Some = a montagem não aconteceu. */
async function alca(indice: number): Promise<HTMLElement> {
  const alvos = await screen.findAllByRole("separator");
  const alvo = alvos[indice];
  if (!alvo) throw new Error(`a divisória ${indice} não renderizou`);
  return alvo;
}

/** A mesma leitura, síncrona, para logo depois de uma interação. */
function alcaAgora(indice: number): HTMLElement {
  const alvo = screen.getAllByRole("separator")[indice];
  if (!alvo) throw new Error(`a divisória ${indice} não renderizou`);
  return alvo;
}

describe("no layout — duas divisorias arrastáveis (#2579)", () => {
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        width: larguraGrade,
        left: 0,
        right: larguraGrade,
        top: 0,
        bottom: 800,
        x: 0,
        y: 0,
        height: 800,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  beforeEach(() => {
    window.localStorage.clear();
    larguraGrade = 1040;
    janelaEm(1440); // faixa xl: padrão 272 (lista) / 296 (ficha)
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    window.history.replaceState(null, "", "/app/inbox");
  });

  it("no celular não nasce divisória nenhuma", async () => {
    janelaEm(500);
    montar();
    // A tela monta (a pergunta de sempre está lá), só a alça que não existe.
    expect(await screen.findByText("Selecione uma conversa")).toBeInTheDocument();
    expect(screen.queryAllByRole("separator")).toEqual([]);
  });

  it("a partir do md há duas divisorias com limite e valor da faixa no aria", async () => {
    montar();
    const lista = await alca(0);
    const ficha = await alca(1);
    expect(lista).toHaveAttribute("aria-orientation", "vertical");
    expect(lista).toHaveAttribute("aria-valuenow", "272");
    expect(lista).toHaveAttribute("aria-valuemin", "240");
    expect(lista).toHaveAttribute("aria-valuemax", "520");
    expect(lista).toHaveAttribute("tabindex", "0");
    expect(ficha).toHaveAttribute("aria-valuenow", "296");
    expect(ficha).toHaveAttribute("aria-valuemin", "260");
    expect(ficha).toHaveAttribute("aria-valuemax", "560");
    // Sem ajuste nenhum a grade é a do CSS: o estilo inline não existe.
    expect(grade().style.gridTemplateColumns).toBe("");
  });

  it("a seta move a divisória, atualiza o valor e grava na faixa certa", async () => {
    montar();
    const lista = await alca(0);
    fireEvent.keyDown(lista, { key: "ArrowRight" });
    expect(lista).toHaveAttribute("aria-valuenow", String(272 + PASSO_TECLADO));
    fireEvent.keyDown(lista, { key: "ArrowRight" });
    expect(lista).toHaveAttribute("aria-valuenow", String(272 + 2 * PASSO_TECLADO));
    // A tecla que não ajusta largura não muda nada.
    fireEvent.keyDown(lista, { key: "Enter" });
    expect(lista).toHaveAttribute("aria-valuenow", String(272 + 2 * PASSO_TECLADO));

    expect(JSON.parse(window.localStorage.getItem(CHAVE_XL) ?? "null")).toEqual({
      lista: 272 + 2 * PASSO_TECLADO,
      ficha: 296,
    });
    expect(grade().style.gridTemplateColumns).toBe("304px minmax(0,1fr) 296px");
  });

  it("arrastar prende no limite e no piso da conversa, e persiste no pointerup", async () => {
    montar();
    const lista = await alca(0);

    fireEvent.pointerDown(lista, { button: 0, pointerId: 1 });
    // 600px passaria do teto E roubaria a conversa: o piso de 420 manda.
    fireEvent.pointerMove(window, { clientX: 600 });
    expect(lista).toHaveAttribute("aria-valuenow", String(1040 - 296 - CONVERSA_MINIMA));

    // Muito à esquerda: trava no piso da própria lista.
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(lista).toHaveAttribute("aria-valuenow", String(LIMITES_LISTA.min));

    // Para uma largura que cabe: 300px, deixando 444px de conversa.
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(lista).toHaveAttribute("aria-valuenow", "300");
    fireEvent.pointerUp(window);

    expect(JSON.parse(window.localStorage.getItem(CHAVE_XL) ?? "null")).toEqual({
      lista: 300,
      ficha: 296,
    });
  });

  it("arrastar a ficha pela direita também prende — a conversa não vira sala de festa", async () => {
    montar();
    const ficha = await alca(1);

    fireEvent.pointerDown(ficha, { button: 0, pointerId: 1 });
    // 600px de ficha: o piso da conversa rebaixa a ficha (e a lista, se preciso).
    fireEvent.pointerMove(window, { clientX: larguraGrade - 600 });
    const agora = Number(ficha.getAttribute("aria-valuenow"));
    expect(agora).toBeLessThanOrEqual(LIMITES_FICHA.max);
    expect(agora).toBeGreaterThanOrEqual(LIMITES_FICHA.min);
    expect(
      1040 - Number(alcaAgora(0).getAttribute("aria-valuenow")) - agora,
    ).toBe(CONVERSA_MINIMA);
    fireEvent.pointerUp(window);

    expect(JSON.parse(window.localStorage.getItem(CHAVE_XL) ?? "null")).toEqual({
      lista: Number(alcaAgora(0).getAttribute("aria-valuenow")),
      ficha: agora,
    });
  });

  it("duplo clique restaura o padrão do CSS e apaga a memória da faixa", async () => {
    montar();
    const lista = await alca(0);

    fireEvent.pointerDown(lista, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 500 });
    fireEvent.pointerUp(window);
    expect(lista).toHaveAttribute("aria-valuenow", "324");
    expect(window.localStorage.getItem(CHAVE_XL)).not.toBeNull();

    fireEvent.doubleClick(lista);
    expect(lista).toHaveAttribute("aria-valuenow", "272");
    expect(window.localStorage.getItem(CHAVE_XL)).toBeNull();
    expect(grade().style.gridTemplateColumns).toBe("");
  });

  it("a largura salva da faixa volta ao montar, já com o clamp aplicado", async () => {
    window.localStorage.setItem(CHAVE_XL, JSON.stringify({ lista: 600, ficha: 296 }));
    montar();
    const lista = await alca(0);
    const ficha = await alca(1);
    // 600 não cabe (teto 520) e ainda roubaria a conversa: fica o que sobra.
    expect(lista).toHaveAttribute("aria-valuenow", String(1040 - 296 - CONVERSA_MINIMA));
    expect(ficha).toHaveAttribute("aria-valuenow", "296");
    expect(grade().style.gridTemplateColumns).toBe("324px minmax(0,1fr) 296px");
  });

  it("a faixa errada não rouba a largura da outra: xl salvo não mexe no md", async () => {
    window.localStorage.setItem(CHAVE_XL, JSON.stringify({ lista: 500, ficha: 400 }));
    janelaEm(1024); // faixa md: padrão da lista é 300, e sem ficha nenhuma
    montar();
    const lista = await alca(0);
    expect(lista).toHaveAttribute("aria-valuenow", "300");
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(grade().style.gridTemplateColumns).toBe("");
  });

  it("seta direita na alça da ficha leva a alça para a direita (a ficha encolhe)", async () => {
    montar();
    const ficha = await alca(1);
    expect(ficha.style.right).toBe("296px");
    fireEvent.keyDown(ficha, { key: "ArrowRight" });
    expect(ficha).toHaveAttribute("aria-valuenow", String(296 - PASSO_TECLADO));
    expect(ficha.style.right).toBe(`${296 - PASSO_TECLADO}px`);
    fireEvent.keyDown(ficha, { key: "ArrowLeft" });
    expect(ficha.style.right).toBe("296px");
  });

  it("armazenamento bloqueado no navegador não derruba o Inbox", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      montar();
      expect(await screen.findByText("Selecione uma conversa")).toBeInTheDocument();
      const lista = await alca(0);
      fireEvent.keyDown(lista, { key: "ArrowRight" });
      expect(lista).toHaveAttribute("aria-valuenow", String(272 + PASSO_TECLADO));
      fireEvent.doubleClick(lista);
      expect(lista).toHaveAttribute("aria-valuenow", "272");
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
