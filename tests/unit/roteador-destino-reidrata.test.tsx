/**
 * #2569 — o editor do roteador mostra "Sem destino" mesmo com o funil gravado.
 *
 * A tela só reidrata o `draftMembers` quando `members` MUDA (`_client.tsx`,
 * `useEffect` sobre `members`), e `members` só muda se o React Query buscar o
 * detalhe. É aí que o defeito mora: com a configuração que o app usa de fato
 * (`makeQueryClient()`, `lib/query/client.ts` — `staleTime: 30_000` e
 * `refetchOnWindowFocus: false`, montada em `app/providers.tsx`), o
 * `initialData` do SSR nasce FRESCO (`dataUpdatedAt = Date.now()`, query-core
 * `query.ts:961`) e `shouldFetchOnMount` (`queryObserver.ts:847`) fica falso:
 * o `GET /api/v1/ai/routers/<id>` NUNCA acontece quando a tela abre. O que se
 * desenha é o snapshot do SSR — e, quando esse snapshot não traz `pipeline_id`,
 * o seletor fica em "Sem destino" para sempre e salvar grava
 * `pipeline_id: null` por cima do destino que está no banco, com a API
 * devolvendo o valor certo o tempo todo.
 *
 * Este arquivo usa `makeQueryClient()` de propósito: um `new QueryClient()`
 * solto (staleTime 0) busca na hora e esconde o defeito — o mesmo motivo pelo
 * qual o teste de reidratação do #2415, que dá o refetch de mão beijada,
 * passava enquanto a tela reprova.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, putMock, authMock, flowsMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  authMock: vi.fn(),
  flowsMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authMock(), usePermission: () => true }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({ useFollowupFlows: flowsMock }));
// A API é dublada, mas o HOOK `useRouter` é o de produção: é ele que decide se
// a busca acontece, e trocá-lo por um stub transformaria o defeito em verde.
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: getMock, post: vi.fn(), put: putMock, patch: vi.fn(), delete: vi.fn() },
}));

import { makeQueryClient } from "@/lib/query/client";
import { RouterEditorClient } from "@/app/app/ai/routers/[id]/_client";

const ROTEADOR = {
  id: "r1",
  name: "Roteador",
  channel_session_id: "s1",
  is_active: true,
  config: {},
  fallback_agent_id: null,
};

/** O que a API de detalhe devolve: destino preenchido (issue #2569). */
const MEMBRO_DA_API = {
  id: "m1",
  agent_id: "a1",
  intent_name: "financiamento",
  intent_description: "quer financiar",
  examples: [],
  position: 0,
  flow_pointer_id: null,
  pipeline_id: "p1",
  stage_id: "e1",
};

/** O snapshot do SSR que chega ao cliente SEM os campos de destino. */
const MEMBRO_DO_SSR = {
  id: "m1",
  agent_id: "a1",
  intent_name: "financiamento",
  intent_description: "quer financiar",
  examples: [],
  position: 0,
  flow_pointer_id: null,
} as typeof MEMBRO_DA_API;

function respostasDaApi() {
  getMock.mockImplementation(async (url: string) => {
    if (url === "/api/v1/ai/routers/r1") {
      return { data: { router: ROTEADOR, members: [MEMBRO_DA_API] } };
    }
    if (url === "/api/v1/pipelines") {
      return { data: [{ id: "p1", name: "Funil Vendas" }] };
    }
    if (url === "/api/v1/pipelines/p1/board") {
      return { data: { stages: [{ id: "e1", name: "Prospecção" }] } };
    }
    return { data: null };
  });
  putMock.mockResolvedValue({ data: { count: 1 } });
}

/** Os defaults REAIS do app (staleTime 30 s, sem refetch em foco). */
function renderEditor(initialState: { router: typeof ROTEADOR; members: typeof MEMBRO_DA_API[] }) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RouterEditorClient
        routerId="r1"
        initialState={initialState}
        agents={[{ id: "a1", name: "Agente" }]}
        channelSessions={[]}
        classifierModels={[]}
      />
    </QueryClientProvider>,
  );
}

const seletorDeDestino = () =>
  screen.getByRole("combobox", { name: "Funil de destino (opcional)" });

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
  respostasDaApi();
  authMock.mockReturnValue({ activeOrg: { modulos_ligados: [] } });
  flowsMock.mockReturnValue({ data: undefined });
});

afterEach(cleanup);

describe("destino do funil no editor do roteador (#2569)", () => {
  it("controle: SSR já com destino mostra o funil sem precisar do detalhe da API", async () => {
    renderEditor({ router: ROTEADOR, members: [{ ...MEMBRO_DO_SSR, pipeline_id: "p1", stage_id: "e1" }] });
    // O texto do item só chega ao gatilho depois que a lista de funis carrega
    // (query sem `initialData`: essa busca acontece com ou sem o fix), por isso
    // a asserção espera — o que este caso prova é que o caminho em que o SSR já
    // traz o destino continua de pé.
    await waitFor(() => expect(seletorDeDestino()).toHaveTextContent("Funil Vendas"));
  });

  it("o destino que só a API tem reidrata o draft: nem 'Sem destino', nem pipeline_id null ao salvar", async () => {
    renderEditor({ router: ROTEADOR, members: [MEMBRO_DO_SSR] });

    // A tela tem de ir buscar o estado atual em vez de confiar no snapshot.
    await waitFor(() => expect(seletorDeDestino()).toHaveTextContent("Funil Vendas"));
    expect(getMock).toHaveBeenCalledWith("/api/v1/ai/routers/r1");

    // E salvar tem de mandar o destino que a API devolveu, não o null do SSR.
    fireEvent.change(screen.getByDisplayValue("financiamento"), {
      target: { value: "financiamento novo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const corpo = putMock.mock.calls[0]?.[1] as
      | { members: Array<{ pipeline_id: string | null; stage_id: string | null }> }
      | undefined;
    expect(corpo?.members[0]?.pipeline_id).toBe("p1");
    expect(corpo?.members[0]?.stage_id).toBe("e1");
  });
});
