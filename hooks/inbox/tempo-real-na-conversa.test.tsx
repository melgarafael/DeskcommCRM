/**
 * O TEMPO REAL DA CONVERSA ABERTA NÃO PEDE REDE (#4325 item 5).
 *
 * O defeito medido na issue: cada evento do canal de `messages` invalidava
 * `["messages", conversaId]` — e, numa `useInfiniteQuery`, invalidar refaz
 * TODAS as páginas do histórico. Com três páginas carregadas, uma mensagem
 * enviada custava três GET de mensagens (mais o da lista, pedido pelo mesmo
 * canal, que o canal de `conversations` já cobre), sendo que o evento já traz a
 * linha inteira.
 *
 * O que este arquivo mede, em número de requisições:
 *  - `INSERT` de mensagem nova: 0 GET, o balão entra no topo de `pages[0]`;
 *  - `UPDATE` de confirmação (enviada/entregue/lida): 0 GET, mescla pelo `id`
 *    na página onde a mensagem estiver;
 *  - `DELETE`: 0 GET, sai do fio;
 *  - o canal NÃO pede a recarga da lista (isso é do canal de `conversations`).
 *
 * SABOTAGEM: voltar o `onChange` de `useMessagesRealtime` para
 * `qc.invalidateQueries({ queryKey: ["messages", conversationId] })` +
 * `agendarRecargaDasConversas(qc)` deixa os quatro primeiros casos vermelhos
 * (1 GET de mensagens por evento, e 1 GET da lista depois de 1,5 s).
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fakes = vi.hoisted(() => ({
  onChange: null as null | ((payload: unknown) => void),
  get: vi.fn(),
}));

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (cfg: { onChange: (payload: unknown) => void }) => {
    fakes.onChange = cfg.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({ useRefetchDeSeguranca: () => ({}) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => fakes.get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));

import { useMessagesRealtime } from "./useMessagesRealtime";

const CONVERSA = "c1";

const leiturasDeMensagens = () =>
  fakes.get.mock.calls.filter(([u]) => String(u).includes("/messages")).length;
const leiturasDaLista = () =>
  fakes.get.mock.calls.filter(([u]) => String(u).startsWith("/api/v1/conversations?")).length;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fio {
  pages: Array<{ data: Array<Record<string, unknown>> }>;
  pageParams: unknown[];
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  renderHook(() => useMessagesRealtime(CONVERSA), { wrapper });
  return qc;
}

const fioNoCache = (qc: QueryClient) =>
  qc.getQueryData<Fio>(["messages", CONVERSA]) ?? { pages: [], pageParams: [] };

/** A página `i` do fio — vazia quando não existe, para o teste falhar na asserção. */
const pagina = (fio: Fio, i: number): { data: Array<Record<string, unknown>> } =>
  fio.pages[i] ?? { data: [] };

/** O histórico como ele fica depois de rolar três páginas para trás. */
async function comTresPaginas() {
  const qc = montar();
  await waitFor(() => expect(leiturasDeMensagens()).toBe(1));
  qc.setQueryData<Fio>(["messages", CONVERSA], {
    pages: [
      {
        data: [
          { id: "m3", body: "terceira", status: "sent" },
          { id: "m2", body: "segunda", status: "sent" },
        ],
      },
      { data: [{ id: "m1", body: "primeira", status: "read" }] },
      { data: [{ id: "m0", body: "antiga", status: "read" }] },
    ],
    pageParams: [undefined, "cur-2", "cur-1"],
  });
  return qc;
}

describe("tempo real da conversa aberta", () => {
  beforeEach(() => {
    fakes.get.mockReset();
    fakes.get.mockImplementation(async () => ({ data: [], meta: { has_more: false } }));
  });

  it("INSERT entra no topo de pages[0] sem nenhum GET", async () => {
    const qc = await comTresPaginas();
    const antes = leiturasDeMensagens();

    fakes.onChange!({
      eventType: "INSERT",
      table: "messages",
      new: { id: "m4", body: "chegou agora", status: "delivered" },
    });

    const fio = fioNoCache(qc);
    expect(pagina(fio, 0).data[0]?.id).toBe("m4");
    expect(pagina(fio, 0).data).toHaveLength(3);
    // A mensagem antiga continua lá: a mescla não reescreve o histórico.
    expect(pagina(fio, 2).data[0]?.id).toBe("m0");
    expect(leiturasDeMensagens(), "o INSERT pediu rede").toBe(antes);
  });

  it("UPDATE de confirmação mescla pelo id, na página onde a mensagem estiver", async () => {
    const qc = await comTresPaginas();
    const antes = leiturasDeMensagens();

    fakes.onChange!({
      eventType: "UPDATE",
      table: "messages",
      new: { id: "m2", status: "read", ack: 3 },
    });
    fakes.onChange!({
      eventType: "UPDATE",
      table: "messages",
      new: { id: "m0", status: "read", ack: 3 },
    });

    const fio = fioNoCache(qc);
    expect(pagina(fio, 0).data[1]).toMatchObject({ id: "m2", status: "read", ack: 3 });
    // O corpo não veio no evento — e não pode ser apagado por isso.
    expect(pagina(fio, 0).data[1]?.body).toBe("segunda");
    expect(pagina(fio, 2).data[0]).toMatchObject({ id: "m0", status: "read" });
    expect(leiturasDeMensagens(), "a confirmação pediu rede").toBe(antes);
  });

  it("DELETE sai do fio sem GET", async () => {
    const qc = await comTresPaginas();
    const antes = leiturasDeMensagens();

    fakes.onChange!({ eventType: "DELETE", table: "messages", old: { id: "m1" } });

    expect(pagina(fioNoCache(qc), 1).data).toHaveLength(0);
    expect(leiturasDeMensagens()).toBe(antes);
  });

  it("INSERT reentregue não duplica o balão", async () => {
    const qc = await comTresPaginas();
    const evento = {
      eventType: "INSERT",
      table: "messages",
      new: { id: "m4", body: "chegou agora" },
    };

    fakes.onChange!(evento);
    fakes.onChange!(evento);

    expect(pagina(fioNoCache(qc), 0).data.filter((m) => m.id === "m4")).toHaveLength(1);
    expect(leiturasDeMensagens()).toBe(1);
  });

  it("o canal de mensagens não pede a recarga da lista", async () => {
    // Quem pede é o canal de `conversations`, que recebe o mesmo fato — pedir
    // pelos dois era metade da carga que a issue mediu.
    await comTresPaginas();

    fakes.onChange!({ eventType: "INSERT", table: "messages", new: { id: "m4" } });
    await esperar(1700);

    expect(leiturasDaLista(), "a lista foi recarregada pelo canal de mensagens").toBe(0);
  });
});
