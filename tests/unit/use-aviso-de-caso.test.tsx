import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

import {
  CHAVE_DO_AVISO,
  useAvisoDeCaso,
  useSalvarAvisoDeCaso,
  type EstadoDoAviso,
} from "@/hooks/ai/useAvisoDeCaso";

function estado(minutos: number[]): EstadoDoAviso {
  return {
    config: {
      channel_session_id: "11111111-1111-4111-8111-111111111111",
      telefone: "+5531999999999",
      rotulo: null,
      ligado: false,
      repetir_lembretes_whatsapp: false,
      minutos_lembrete_equipe: minutos,
      atualizado_em: "2026-10-07T12:00:00.000Z",
    },
    conexoes: [],
    avisos: [],
    pode_ligar: false,
    entregas: [],
    laco: {
      comAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
      semAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
      medianaAteOAvisoMinutos: null,
    },
  };
}

function criarWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => vi.resetAllMocks());

describe("hooks do aviso de caso e cadência configurável", () => {
  it("lê os minutos do GET e grava a resposta completa no cache após PUT", async () => {
    const inicial = estado([2, 8]);
    const salvo = estado([1, 5, 20, 1440]);
    api.get.mockResolvedValue({ data: inicial });
    api.put.mockResolvedValue({ data: salvo });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = criarWrapper(queryClient);
    const leitura = renderHook(() => useAvisoDeCaso(), { wrapper });
    await waitFor(() => expect(leitura.result.current.data?.config?.minutos_lembrete_equipe).toEqual([2, 8]));

    const salvar = renderHook(() => useSalvarAvisoDeCaso(), { wrapper });
    const entrada = {
      channel_session_id: "11111111-1111-4111-8111-111111111111",
      telefone: "+5531999999999",
      rotulo: null,
      ligado: false,
      repetir_lembretes_whatsapp: false,
      minutos_lembrete_equipe: [1, 5, 20, 1440],
    };
    await act(async () => salvar.result.current.mutateAsync(entrada));

    expect(api.put).toHaveBeenCalledWith("/api/v1/ai/cases/alerta", entrada);
    expect(queryClient.getQueryData<EstadoDoAviso>(CHAVE_DO_AVISO)?.config?.minutos_lembrete_equipe)
      .toEqual([1, 5, 20, 1440]);
  });
});
