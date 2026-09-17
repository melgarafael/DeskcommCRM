import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O encanamento de `exclude_finished`, ponta a ponta.
 *
 * `inbox-aba-minhas-sem-fechadas.test.ts` prova as duas pontas — o significado
 * da aba e o predicado SQL. Este arquivo prova os dois elos DO MEIO, que são os
 * que somem sem barulho: o hook precisa mandar o parâmetro na query string, e a
 * rota precisa lê-lo da URL.
 *
 * Não é zelo: a rota já tem um caso vivo desse esquecimento — o filtro por
 * `tag` é serializado pelo hook e implementado pelo handler, mas a rota nunca o
 * lê de `searchParams`, então escolher uma tag na tela não filtra nada. Um
 * parâmetro que atravessa três arquivos precisa de teste nos três.
 */

// Tipado com a URL: o teste lê o 1º argumento, e `(...a: unknown[])` o esconde.
const getSpy = vi.fn(async (_url: string, _opts?: { signal?: AbortSignal }) => ({
  data: [],
  meta: { has_more: false, cursor: null },
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string, opts?: { signal?: AbortSignal }) => getSpy(url, opts),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));

import { useConversationsRealtime } from "@/hooks/inbox/useConversationsRealtime";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** A URL que o hook pediu. */
async function urlPedida(filtros: Parameters<typeof useConversationsRealtime>[0]) {
  renderHook(() => useConversationsRealtime(filtros, "org-1"), { wrapper });
  await waitFor(() => expect(getSpy).toHaveBeenCalled());
  return getSpy.mock.calls.at(-1)?.[0] ?? "";
}

describe("elo do meio 1 — o hook serializa", () => {
  beforeEach(() => getSpy.mockClear());

  it("manda exclude_finished=true quando a aba pede", async () => {
    expect(await urlPedida({ assigned_to: "me", exclude_finished: true })).toContain(
      "exclude_finished=true",
    );
  });

  it("NÃO manda nada quando a aba não pede", async () => {
    expect(await urlPedida({ assigned_to: "me" })).not.toContain("exclude_finished");
  });

  it("cancela a leitura obsoleta quando uma nova invalidação chega", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function wrapperDaInvalidacao({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }
    renderHook(() => useConversationsRealtime({}, "org-1"), {
      wrapper: wrapperDaInvalidacao,
    });
    await waitFor(() =>
      expect(
        qc.getQueryCache().find({ queryKey: ["conversations"], exact: false })?.state.status,
      ).toBe("success"),
    );

    // A primeira invalidação fica em voo; a segunda precisa substituí-la sem
    // deixar o navegador carregar as duas em paralelo.
    getSpy.mockImplementationOnce(() => new Promise(() => {}));
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));

    const signal = getSpy.mock.calls[1]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    void qc.invalidateQueries({ queryKey: ["conversations"] });
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(3));
  });
});

// ---------------------------------------------------------------------------

// Tipado com os 3 parâmetros reais: o teste lê o 3º (o `q` montado pela rota),
// e com `(...a: unknown[])` esse índice não existe no tipo.
const handlerSpy = vi.fn(
  async (_sb: unknown, _ctx: unknown, _q: Record<string, unknown>) => ({
    conversations: [],
    cursor: null,
    has_more: false,
  }),
);
vi.mock("@/app/api/v1/conversations/_handler", () => ({
  listConversationsHandler: (sb: unknown, ctx: unknown, q: Record<string, unknown>) =>
    handlerSpy(sb, ctx, q),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: async () => ({ id: "user-1" }),
  resolveActiveOrg: async () => ({ orgId: "org-1" }),
}));

const { GET } = await import("@/app/api/v1/conversations/route");

/** O `q` com que a rota chamou o handler. */
async function queryRecebida(qs: string) {
  handlerSpy.mockClear();
  await GET(new Request(`http://localhost/api/v1/conversations?${qs}`) as never);
  return handlerSpy.mock.calls.at(-1)?.[2] ?? {};
}

describe("elo do meio 2 — a rota lê da URL", () => {
  it("exclude_finished=true chega ao handler", async () => {
    expect((await queryRecebida("assigned_to=me&exclude_finished=true")).exclude_finished).toBe(true);
  });

  it("sem o parâmetro, o handler não recebe o filtro", async () => {
    expect((await queryRecebida("assigned_to=me")).exclude_finished).toBeUndefined();
  });

  it("só a string 'true' liga — 'false' não pode ligar por ser não-vazia", async () => {
    expect((await queryRecebida("exclude_finished=false")).exclude_finished).toBeUndefined();
    expect((await queryRecebida("exclude_finished=0")).exclude_finished).toBeUndefined();
  });
});
