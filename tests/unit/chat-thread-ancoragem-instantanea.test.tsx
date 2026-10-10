import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types/messaging";

/**
 * A PRIMEIRA ANCORAGEM É INSTANTÂNEA; AS SEGUINTES, SUAVES (#1590, PR #1617).
 *
 * Ao abrir uma conversa, o fio ia ao fim com `behavior: "smooth"`: quem atende
 * via o histórico antigo passando e esperava a animação antes de ler a última
 * mensagem. A regra agora é `auto` na abertura de cada conversa — inclusive a
 * que abre VAZIA e recebe o conteúdo depois (o cartão de passagem chega após a
 * primeira pintura, ver o comentário do efeito em ChatThread.tsx) — e `smooth`
 * só para o que chega depois.
 *
 * Nenhum outro teste renderiza o ChatThread de verdade, então sem este nada
 * impediria a linha de voltar a `smooth` fixo.
 */

const estado = vi.hoisted(() => ({
  mensagens: [] as unknown[],
  carregando: false,
  passagens: [] as unknown[],
}));

vi.mock("@/hooks/inbox/useMessagesRealtime", () => ({
  useMessagesRealtime: () => ({
    // `data: undefined` durante o carregamento é o que o `useInfiniteQuery`
    // devolve de verdade — e é o que faz o ChatThread desenhar o esqueleto.
    data: estado.carregando ? undefined : { pages: [{ data: estado.mensagens }] },
    isLoading: estado.carregando,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/inbox/useConversationNotes", () => ({ useConversationNotes: () => [] }));
vi.mock("@/hooks/inbox/usePassagensDaConversa", () => ({
  usePassagensDaConversa: () => estado.passagens,
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useDeleteNote", () => ({ useDeleteNote: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/ai/useDebugToggle", () => ({ useDebugToggle: () => ({ enabled: false }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ role: "agent" }),
  useUser: () => ({ id: "u-1" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/components/inbox/MessageBubble", () => ({ MessageBubble: () => <div /> }));
vi.mock("@/components/inbox/NoteCard", () => ({ NoteCard: () => null }));
vi.mock("@/components/inbox/PassagemCard", () => ({ PassagemCard: () => null }));

import { ChatThread } from "@/components/inbox/ChatThread";

function mensagem(n: number): Message {
  return {
    id: `m-${n}`,
    sent_at: new Date(Date.UTC(2026, 8, 24, 12, n)).toISOString(),
    reply_to_message_id: null,
  } as unknown as Message;
}

// O ChatThread usa `useAlterarMensagem` (react-query) desde o #1626; o `wrapper`
// do RTL é mantido no `rerender`, e o cliente é um só por teste.
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

/**
 * A GEOMETRIA DO FIO, QUE O JSDOM NÃO TEM.
 *
 * Os três atributos que a guarda de distância lê (`scrollHeight - scrollTop -
 * clientHeight`) valem 0 em jsdom, porque jsdom não faz layout. Com tudo em 0 a
 * guarda enxerga `0 > 120` = falso e passa — o defeito da #2515 (fio parado no
 * topo, convite em `base=1028` numa janela de 720, medido na run 37660047994)
 * fica invisível para o teste e o vermelho nunca aparece.
 *
 * Os números são os medidos naquela rodada: 308px de conteúdo acima da dobra,
 * quase 3× o teto de 120.
 */
function comGeometriaDoFio(): () => void {
  const medidos = { scrollHeight: 1028, scrollTop: 0, clientHeight: 720 };
  const originais = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop"),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  for (const [propriedade, valor] of Object.entries(medidos)) {
    Object.defineProperty(HTMLElement.prototype, propriedade, {
      configurable: true,
      get: () => valor,
      set: () => {},
    });
  }
  return () => {
    for (const [propriedade, descritor] of Object.entries(originais)) {
      if (descritor) Object.defineProperty(HTMLElement.prototype, propriedade, descritor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[propriedade];
    }
  };
}

/** Uma passagem de verdade: o cartão "por que a IA passou para você". */
function passagem(criadoEm: string): unknown {
  return {
    id: "pg-1",
    origem: "pedido_explicito",
    motivo_codigo: "requested_human",
    title: "Troca do produto",
    body: "O cliente escreveu troca de produto e a IA encerrou o assunto sem resposta.",
    notes: null,
    content: null,
    tentativas: [],
    cliente_avisado: null,
    aviso_motivo_codigo: null,
    caso_id: null,
    criado_em: criadoEm,
    reconhecido_em: null,
    reconhecido_por: null,
  };
}

const rolar = vi.fn();
const original = Element.prototype.scrollIntoView;

/** O `behavior` de cada chamada, em ordem. */
function comportamentos(): unknown[] {
  return rolar.mock.calls.map((c) => (c[0] as ScrollIntoViewOptions).behavior);
}

describe("ChatThread: ancoragem ao fim", () => {
  beforeEach(() => {
    qc = new QueryClient();
    rolar.mockClear();
    estado.mensagens = [];
    estado.carregando = false;
    estado.passagens = [];
    Element.prototype.scrollIntoView = rolar;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("abre a conversa com histórico indo ao fim SEM animação", () => {
    estado.mensagens = [mensagem(1), mensagem(2)];
    render(<ChatThread conversationId="c-1" />, { wrapper });
    expect(rolar).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
    expect(comportamentos()).not.toContain("smooth");
  });

  it("mensagem nova, depois da abertura, rola suave", () => {
    estado.mensagens = [mensagem(1)];
    const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
    rolar.mockClear();
    estado.mensagens = [mensagem(1), mensagem(2)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(comportamentos()).toEqual(["smooth"]);
  });

  it("conversa que abre vazia: o primeiro conteúdo que chega ainda é a abertura (auto)", () => {
    const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
    estado.mensagens = [mensagem(1)];
    rerender(<ChatThread conversationId="c-1" />);
    expect(comportamentos()).toEqual(["auto"]);
  });

  it("trocar de conversa volta a abrir instantâneo", () => {
    estado.mensagens = [mensagem(1)];
    const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
    rolar.mockClear();
    rerender(<ChatThread conversationId="c-2" />);
    expect(comportamentos()).toEqual(["auto"]);
  });

  /**
   * A PASSAGEM CHEGA ANTES DAS MENSAGENS (#2515).
   *
   * As passagens vêm de `usePassagensDaConversa`, uma consulta própria, e podem
   * resolver ANTES da de mensagens. Aí `items.length` já é 1 enquanto
   * `q.isLoading` ainda é verdadeiro — e o ramo do esqueleto NÃO monta
   * `scrollerRef` nem `bottomRef`. O efeito de ancoragem marcava
   * `jaAncorou.current = true` (havia item na tela) e chamava `scrollIntoView`
   * sobre um `bottomRef` nulo: nada rolava, mas a abertura já estava consumida.
   * Quando as mensagens chegam, a guarda de distância lê 308px até o fim,
   * acha que o usuário está lendo o histórico e devolve sem rolar — o convite
   * "Assumir e responder" fica abaixo da dobra e ninguém o vê.
   *
   * A geometria é a medida na run 37660047994 (`base=1028`, `janela=720`): sem
   * ela o jsdom devolve 0 em tudo e a guarda passa em qualquer mundo.
   */
  it("cartão de passagem antes das mensagens: o fio termina rolado até o fim", () => {
    const restaurarGeometria = comGeometriaDoFio();
    try {
      // 1. as passagens resolveram; a consulta de mensagens ainda está no ar.
      estado.carregando = true;
      estado.passagens = [passagem(new Date(Date.UTC(2026, 8, 24, 12, 3)).toISOString())];
      const { rerender } = render(<ChatThread conversationId="c-1" />, { wrapper });
      // O esqueleto está na tela: nenhum ref do fio existe, logo nada rolou.
      expect(rolar).not.toHaveBeenCalled();

      // 2. as mensagens chegam e o fio de verdade é montado.
      estado.carregando = false;
      estado.mensagens = [mensagem(1), mensagem(2)];
      rerender(<ChatThread conversationId="c-1" />);

      expect(
        comportamentos(),
        "sem a ancoragem, o fio fica no topo e 'Assumir e responder' fica abaixo da dobra",
      ).toEqual(["auto"]);
    } finally {
      restaurarGeometria();
    }
  });
});
