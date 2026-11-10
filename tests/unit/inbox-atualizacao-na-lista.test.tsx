import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ATUALIZAÇÃO DA AUTOMAÇÃO ENTRA NA LISTA SEM REFazer A BUSCA (#2366).
 *
 * ─── O defeito, medido ───────────────────────────────────────────────────────
 * Quando uma automação aplica etiqueta/estado na conversa, o Realtime entrega um
 * `UPDATE` de `public.conversations`. O inbox tratava TODO evento igual:
 * `invalidateQueries(["conversations"])` — busca completa da lista, para um
 * evento que mudou UMA linha. Medido nesta suíte, antes do conserto: a lista
 * recebia a primeira página (1 GET), o evento chegava e um SEGUNDO GET saía, com
 * a linha ainda mostrando os valores velhos até a resposta — a cada evento da
 * rajada. É isso que a tela mostra como piscada: a lista inteira refeita, a
 * posição e o scroll do operador refeitos junto.
 *
 * ─── O que cada caso prova ──────────────────────────────────────────────────
 *   1. CONTROLE: primeira carga ainda mostra o skeleton (sem ele, "não piscar"
 *      seria verdadeiro por acidente);
 *   2. ⭐ o `UPDATE` de uma conversa que ESTÁ na lista: nenhum GET novo, nenhum
 *      skeleton, e a linha afetada já mostra os valores novos — na MESMA
 *      posição;
 *   3. CONTROLE: conversa NOVA (que não estava na lista) ainda entra — a recarga
 *      continua existindo para quem pode ter entrado no filtro;
 *   4. conversa que SAI do filtro sai de fato (mesmo sem GET novo);
 *   5. rajada de eventos da mesma conversa não multiplica busca.
 *
 * ─── O que este arquivo NÃO finge ───────────────────────────────────────────
 * A etiqueta do CONTATO (`contacts.tags`, o miolo do chip da linha) não viaja
 * num evento de `conversations`: é outra tabela. O que o evento traz é
 * `conversations.tags` — o campo que o filtro de marcador lê —, e é ele que a
 * linha falsa deste teste desenha. Um evento desta tabela não pode atualizar o
 * chip do contato, e nenhum teste aqui afirma que atualiza.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: true }) }));
/** A linha é dublê de propósito: este arquivo mede o DADO que chega até ela. */
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({
    conversation,
  }: {
    conversation: {
      id: string;
      status?: string;
      last_message_preview?: string | null;
      tags?: string[];
    };
  }) => (
    <div data-testid="linha" data-conversa={conversation.id}>
      {conversation.id}|{conversation.status}|{conversation.last_message_preview}|
      {(conversation.tags ?? []).join("+")}
    </div>
  ),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({
    divergencias: 0,
    ultimaDivergencia: null,
    ultimaVerificacao: null,
  }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

/** O canal falso guarda o `onChange` real — é por ele que o evento entra. */
const canal = vi.hoisted(() => ({
  onChange: null as null | ((payload: unknown) => void),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (cfg: { onChange: (payload: unknown) => void }) => {
    canal.onChange = cfg.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));

/**
 * CADA GET FICA EM BOLSA — o teste decide quando a resposta chega, e é assim que
 * ele afirma "nenhuma busca nova saiu" sem depender de tempo.
 */
const chamadas = vi.hoisted(
  () =>
    [] as {
      url: string;
      resolver: (resposta: unknown) => void;
      recusar: (erro: unknown) => void;
    }[],
);
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) =>
      new Promise((resolver, recusar) => {
        chamadas.push({ url, resolver, recusar });
      }),
  },
}));

/**
 * Só o TIPO vem estaticamente (é apagado na compilação, não atrapalha o
 * `vi.mock`): o hook em si é importado depois dos dublês, para o módulo já
 * enxergar os mocks.
 */
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

const { ConversationList } = await import("@/components/inbox/ConversationList");
const { useConversationsRealtime } = await import("@/hooks/inbox/useConversationsRealtime");

/** Uma linha de resposta, com os campos que a linha da lista lê. */
function conversa(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    status: "open",
    last_message_preview: `última de ${id}`,
    tags: [],
    contacts: { id: `contato-${id}`, display_name: id, name: id, phone_number: "+5511900000000", tags: [] },
    ...extras,
  };
}

function pagina(linhas: ReturnType<typeof conversa>[]) {
  return { data: linhas, meta: { has_more: false, cursor: null } };
}

/** O esqueleto de carregamento — a âncora é o atributo, não a classe. */
const esqueleto = () => document.querySelectorAll("[data-esqueleto]").length;

/** Uma entrega do Realtime, no formato que o supabase-js entrega. */
function evento(eventType: "INSERT" | "UPDATE" | "DELETE", linha: Record<string, unknown>) {
  return {
    type: "postgres_changes",
    eventType,
    schema: "public",
    table: "conversations",
    new: linha,
    old: {},
  };
}

function Tela({ filtros }: { filtros: ConversationsFilters }) {
  const q = useConversationsRealtime(filtros, "org-1");
  return (
    <>
      <ConversationList
        listQuery={q}
        filters={filtros}
        selectedId={null}
        onSelect={() => undefined}
      />
      <div
        data-testid="estado"
        data-carregando={q.isLoading}
        data-buscando={q.isFetching}
      />
    </>
  );
}

function montar(filtros: ConversationsFilters) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Tela filtros={filtros} />
    </QueryClientProvider>,
  );
  return qc;
}

function busca(indice: number) {
  const chamada = chamadas[indice];
  if (!chamada) throw new Error(`nenhum GET na posição ${indice} — a fila tem ${chamadas.length}`);
  return chamada;
}

async function entregar(indice: number, linhas: ReturnType<typeof conversa>[]) {
  await act(async () => {
    busca(indice).resolver(pagina(linhas));
  });
}

/** Entrega um evento do Realtime e deixa o efeito (e a janela de agrupamento) correr. */
async function entregarEvento(payload: Record<string, unknown>) {
  await act(async () => {
    canal.onChange!(payload);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

const linhas = () =>
  Array.from(document.querySelectorAll('[data-testid="linha"]')).map((n) => n.textContent);

beforeEach(() => {
  chamadas.length = 0;
  canal.onChange = null;
});
afterEach(() => cleanup());

describe("a automação atualiza a conversa sem refazer a busca da lista (#2366)", () => {
  it("CONTROLE: a primeira carga mostra o skeleton", async () => {
    montar({ status: "open" });
    await waitFor(() => expect(chamadas).toHaveLength(1));
    expect(esqueleto()).toBeGreaterThan(0);
  });

  it("⭐ UPDATE de conversa que está na lista: nenhum GET novo, nenhum skeleton, linha atualizada", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c2\|/)).toBeInTheDocument());
    expect(chamadas).toHaveLength(1);
    expect(esqueleto()).toBe(0);

    await entregarEvento(
      evento("UPDATE", {
        id: "c1",
        status: "open",
        last_message_preview: "atendida pela automação",
        tags: ["vip"],
      }),
    );

    expect(
      chamadas.length,
      "um evento de UMA conversa não pode declarar a lista inteira velha",
    ).toBe(1);
    expect(esqueleto(), "a lista não pode voltar ao skeleton").toBe(0);
    expect(linhas()).toEqual([
      "c1|open|atendida pela automação|vip",
      "c2|open|última de c2|",
    ]);
    expect(screen.getByTestId("estado").dataset.buscando).toBe("false");
  });

  it("CONTROLE: conversa NOVA (que não estava na lista) ainda entra — a recarga existe para ela", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    await entregarEvento(evento("INSERT", conversa("c3")));
    await waitFor(() => expect(chamadas).toHaveLength(2), { timeout: 3000 });

    await entregar(1, [conversa("c3"), conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c3\|/)).toBeInTheDocument());
  });

  it("conversa que SAI do filtro sai de fato, sem esperar uma busca", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    // A automação encerrou a conversa: ela não pertence mais à aba "Abertas".
    await entregarEvento(
      evento("UPDATE", {
        id: "c1",
        status: "resolved",
        last_message_preview: "encerrada pela automação",
        tags: [],
      }),
    );

    await waitFor(() => expect(linhas()).toEqual(["c2|open|última de c2|"]));
    expect(chamadas).toHaveLength(1);
    expect(esqueleto()).toBe(0);
  });

  it("o que muda a ORDEM da lista continua pedindo o servidor (a conversa que recebeu sobe)", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c2\|/)).toBeInTheDocument());

    // Mensagem nova numa conversa que já estava na lista: `last_message_at` muda,
    // e com ele a POSIÇÃO. Quem sabe reordenar (e desempatar por `id`) é a rota.
    await entregarEvento(
      evento("UPDATE", {
        id: "c2",
        status: "open",
        last_message_at: "2026-10-31T18:00:00.000Z",
        last_message_preview: "mensagem nova",
        tags: [],
      }),
    );
    await waitFor(() => expect(chamadas).toHaveLength(2), { timeout: 3000 });

    await entregar(1, [conversa("c2", { last_message_preview: "mensagem nova" }), conversa("c1")]);
    await waitFor(() => expect(linhas()[0]).toMatch(/^c2\|/));
  });

  it("rajada de eventos da mesma conversa não multiplica busca", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    for (const etiqueta of ["vip", "vip+abc", "vip+abc+xyz"]) {
      await act(async () => {
        canal.onChange!(
          evento("UPDATE", {
            id: "c1",
            status: "open",
            last_message_preview: `passo ${etiqueta}`,
            tags: etiqueta.split("+"),
          }),
        );
      });
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(chamadas).toHaveLength(1);
    expect(linhas()).toEqual([`c1|open|passo vip+abc+xyz|vip+abc+xyz`]);
  });
});
