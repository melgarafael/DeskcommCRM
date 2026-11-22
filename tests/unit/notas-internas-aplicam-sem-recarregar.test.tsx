/**
 * A NOTA QUE CHEGA PELO CANAL ENTRA NA TELA SEM RECARREGAR (#1863, F1).
 *
 * O defeito da issue é de SILÊNCIO: o canal sobe, responde `SUBSCRIBED` e nada
 * chega. Consertar a publicação (`0478`) e a identidade do DELETE (a migration
 * desta fatia) só vale se o hook, ao RECEBER o evento, aplicar a nota — sem F5.
 *
 * Aqui o canal é um DUBLÊ que guarda as opções assinadas e entrega o evento na
 * mão. O que se mede é o efeito: a lista devolvida pelo hook muda, na MESMA
 * instância de componente, e a assinatura pede a tabela certa com o filtro por
 * `conversation_id`. Se o filtro sair daqui, a prova do DELETE medida em
 * `notas-internas-realtime-do-delete.test.ts` deixa de corresponder ao código —
 * por isso a assinatura é asserção, não detalhe.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Note } from "@/lib/types/messaging";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));

/** Dublê do canal: guarda o que foi assinado e deixa o teste entregar. */
const canais = vi.hoisted(
  () =>
    [] as {
      name: string;
      enabled?: boolean;
      postgresChanges?: { event: string; schema?: string; table: string; filter?: string };
      onChange: (payload: unknown) => void;
    }[],
);
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: (typeof canais)[number]) => {
    canais.push(opts);
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));

const { useConversationNotes } = await import("@/hooks/inbox/useConversationNotes");

const CONVERSA = "33333333-3333-4333-8333-333333333333";

function nota(id: string, body: string): Note {
  return {
    id,
    conversation_id: CONVERSA,
    body,
    created_by_user_id: "44444444-4444-4444-8444-444444444444",
    created_by_name: "Ana",
    created_at: "2026-11-07T12:00:00.000Z",
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    media_expired_at: null,
    media_retention_days: null,
  } as Note;
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  canais.length = 0;
  get.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("useConversationNotes — o evento do canal aplica a nota", () => {
  it("assina conversation_notes filtrando pela conversa aberta", async () => {
    get.mockResolvedValue({ data: [nota("n1", "primeira")] });
    const { result } = renderHook(() => useConversationNotes(CONVERSA), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    expect(canais.at(-1)?.postgresChanges).toEqual({
      event: "*",
      schema: "public",
      table: "conversation_notes",
      filter: `conversation_id=eq.${CONVERSA}`,
    });
    expect(canais.at(-1)?.enabled).toBe(true);
  });

  it("a nota que chega pelo canal aparece sem recarregar a página", async () => {
    get.mockResolvedValue({ data: [nota("n1", "primeira")] });
    const { result } = renderHook(() => useConversationNotes(CONVERSA), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    // O que o servidor passa a devolver depois do INSERT feito por outra pessoa.
    get.mockResolvedValue({ data: [nota("n1", "primeira"), nota("n2", "anotação do colega")] });

    const canal = canais.at(-1)!;
    await act(async () => {
      canal.onChange({
        eventType: "INSERT",
        schema: "public",
        table: "conversation_notes",
        new: nota("n2", "anotação do colega"),
        old: {},
      });
    });

    await waitFor(() => expect(result.current.map((n) => n.id)).toEqual(["n1", "n2"]));
    // Sem F5 e sem remontar: é a MESMA instância do hook que passou a mostrar a nota.
    expect(result.current[1]!.body).toBe("anotação do colega");
  });

  it("a nota apagada por outra pessoa some da tela", async () => {
    get.mockResolvedValue({ data: [nota("n1", "primeira"), nota("n2", "vai sumir")] });
    const { result } = renderHook(() => useConversationNotes(CONVERSA), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(2));

    get.mockResolvedValue({ data: [nota("n1", "primeira")] });

    const canal = canais.at(-1)!;
    await act(async () => {
      // O registro ANTIGO de um DELETE só traz `conversation_id` quando a tabela
      // está com `replica identity full` — a razão de a migration existir.
      canal.onChange({
        eventType: "DELETE",
        schema: "public",
        table: "conversation_notes",
        new: {},
        old: { id: "n2", conversation_id: CONVERSA },
      });
    });

    await waitFor(() => expect(result.current.map((n) => n.id)).toEqual(["n1"]));
  });

  it("sem conversa aberta não assina nada (o canal desligado não mente)", async () => {
    const { result } = renderHook(() => useConversationNotes(null), { wrapper });
    expect(result.current).toEqual([]);
    expect(canais.at(-1)?.enabled).toBeFalsy();
    expect(canais.at(-1)?.postgresChanges).toBeUndefined();
  });
});
