/**
 * Central de Conexões — a ação em lote "Pausar todas / Retomar todas" (#2387).
 *
 * O que este arquivo cobre, e por que não bastaria testar a rota:
 *
 *  1. UM clique leva a lista INTEIRA num pedido só (3 canais → 1 `patch`, não
 *     3) e o toast divulga a conta que a API devolveu — `alterados` e
 *     `jaEstavam` juntos, no mesmo texto (critério 1 da issue);
 *  2. a lista está sempre ATRASADA em relação ao banco: o servidor pode já ter
 *     pausado os canais enquanto a tela ainda os mostra ligados. Aí o toast
 *     diz "Nada mudou", nunca "Feito: 3 pausados" (critério 3);
 *  3. falha parcial vira UM toast de erro com OS IDS, e a asserção de que
 *     `toast.success` NÃO foi chamado é o que provaria o contrário (critério 5
 *     — "a tela não afirma sucesso total");
 *  4. cada botão só existe quando tem alvo: "Retomar todas" sem ninguém
 *     pausado promete uma conta que não fecha;
 *  5. um invalidate() só para a ação inteira, não um por canal (critério 8).
 *
 * A frase em si é testada à parte, em `frasesDoLoteDePausa`, porque é uma
 * função pura: dali saem os critérios 1, 2 e 3 por contagem de casos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    patch: (...a: unknown[]) => patchMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock("@/hooks/channels/usePacingKnobs", () => ({ usePacingKnobs: () => ({ data: { items: [] } }) }));
vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem: {
  data: ChannelSession[] | undefined;
  isLoading: boolean;
  isError: boolean;
  schemaOutdated: boolean;
} = { data: [], isLoading: false, isError: false, schemaOutdated: false };

vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient, frasesDoLoteDePausa } from "@/components/connections/ConnectionsClient";

type Resultado = Parameters<typeof frasesDoLoteDePausa>[0];

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function canal(id: string, over: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id,
    waha_session_name: `org_1111_${id.slice(0, 3)}`,
    display_name: `Número ${id.slice(0, 1).toUpperCase()}`,
    phone_number: "5511999999999",
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 250,
    is_warmup_complete: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const lote = (sobre: Partial<Resultado> = {}): { data: Resultado } => ({
  data: {
    disabled: true,
    pedidos: 3,
    alterados: 3,
    jaEstavam: 0,
    arquivados: 0,
    falharam: [],
    ...sobre,
  },
});

let qc: QueryClient;
/**
 * Espião do invalidate — declarado estruturalmente de propósito: `vi.spyOn` sem
 * os tipos do alvo vem como `MockInstance` genérico e o `([op])` do filtro
 * cai em `implicitly any` no typecheck (medido: TS7031 na linha 112).
 */
let invalidacoes: { mock: { calls: unknown[][] } };

function wrap(ui: React.ReactNode) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/** Quantas vezes a LISTA de conexões foi invalidada (chave `channel-sessions`). */
function invalidacoesDaLista(): number {
  return invalidacoes.mock.calls.filter(
    ([op]) => (op as { queryKey?: string[] } | undefined)?.queryKey?.[0] === "channel-sessions",
  ).length;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  // `wahaConfigured={false}` de propósito: com o serviço no ar a tela faz
  // health check ao montar, que também chama invalidate() e poluiria a contagem
  // do critério 8. Pausar não depende do serviço — é gravar `metadata.disabled`.
  getMock.mockResolvedValue({ data: {} });
  listagem.data = [canal(A), canal(B), canal(C)];
  listagem.isLoading = false;
  listagem.isError = false;
  listagem.schemaOutdated = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Pausar todas / Retomar todas", () => {
  it("três canais ligados: um clique faz UM pedido e o toast declara a conta", async () => {
    patchMock.mockResolvedValue(lote());
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    invalidacoes = vi.spyOn(qc, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Pausar todas (3)" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/api/v1/channel-sessions/disabled", {
        disabled: true,
        ids: [A, B, C],
      }),
    );
    // O ponto da issue: N cliques viraram 1 requisição.
    expect(patchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Feito: 3 canais pausados agora."));
    expect(toastError).not.toHaveBeenCalled();
    // Critério 8: um invalidate() só — a chave da lista foi tocada UMA vez.
    await waitFor(() => expect(invalidacoesDaLista()).toBe(1));
    expect(invalidacoes).toHaveBeenCalledTimes(2); // channel-sessions + pacing-knobs
  });

  it("lista atrasada (servidor já pausou tudo): 'Nada mudou', nunca 'Feito'", async () => {
    // Os três aparecem ligados na tela, mas o banco já está pausado: é o caso
    // idempotente em que um segundo clique NÃO pode regravar nem reauditar.
    patchMock.mockResolvedValue(lote({ alterados: 0, jaEstavam: 3 }));
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    invalidacoes = vi.spyOn(qc, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Pausar todas (3)" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(
      "Nada mudou: 3 canais já estavam pausados.",
    ));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalledWith("Feito: 3 canais pausados agora.");
  });

  it("falha parcial: um erro com os ids e NENHUM toast de sucesso", async () => {
    patchMock.mockResolvedValue(lote({ alterados: 1, falharam: [B, C] }));
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    invalidacoes = vi.spyOn(qc, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Pausar todas (3)" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      `Não foi possível pausar 2 canais: ${B}, ${C}. 1 canal pausado agora.`,
    ));
    // A asserção que separa "avisou" de "afirmou sucesso total".
    expect(toastSuccess).not.toHaveBeenCalled();
    // A falha parcial mudou um canal de verdade: a lista ainda é recarregada.
    await waitFor(() => expect(invalidacoesDaLista()).toBe(1));
  });

  it("erro de rede vira aviso, e a lista é recarregada mesmo assim", async () => {
    patchMock.mockRejectedValue(new Error("500"));
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    invalidacoes = vi.spyOn(qc, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Pausar todas (3)" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Não foi possível mudar o estado dos canais."),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(invalidacoesDaLista()).toBe(1));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it("cada botão só existe quando tem alvo", () => {
    // Ninguém pausado: não há o que retomar.
    listagem.data = [canal(A), canal(B)];
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    expect(screen.getByRole("button", { name: "Pausar todas (2)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retomar todas/ })).not.toBeInTheDocument();
    cleanup();

    // Todos pausados: não há o que pausar.
    listagem.data = [canal(A, { metadata: { disabled: true } })];
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    expect(screen.queryByRole("button", { name: /Pausar todas/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retomar todas (1)" })).toBeInTheDocument();
  });

  it("Retomar todas usa a MESMA rota com disabled false", async () => {
    listagem.data = [canal(A, { metadata: { disabled: true } })];
    patchMock.mockResolvedValue(lote({ disabled: false, pedidos: 1, alterados: 1 }));
    render(wrap(<ConnectionsClient wahaConfigured={false} />));

    fireEvent.click(screen.getByRole("button", { name: "Retomar todas (1)" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/api/v1/channel-sessions/disabled", {
        disabled: false,
        ids: [A],
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Feito: 1 canal reativado agora."));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("lista vazia não oferece ação em lote nenhuma", () => {
    listagem.data = [];
    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    expect(screen.queryByRole("button", { name: /Pausar todas/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retomar todas/ })).not.toBeInTheDocument();
  });
});

/**
 * A frase é função pura e é ela que os critérios 1, 2 e 3 cobrem — o teste de
 * cima só provaria que o clique chega ao endpoint.
 */
describe("frasesDoLoteDePausa", () => {
  it("junta o que mudou, o que já estava e o que ficou de fora — sem virar erro", () => {
    expect(
      frasesDoLoteDePausa({
        disabled: true,
        pedidos: 3,
        alterados: 1,
        jaEstavam: 1,
        arquivados: 1,
        falharam: [],
      }),
    ).toEqual({
      sucesso: "Feito: 1 canal pausado agora, 1 canal já estava pausado e 1 canal arquivado fica de fora.",
      erro: null,
    });
  });

  it("arquivado sozinho não é sucesso nem erro: é um 'nada mudou' que diz por quê", () => {
    expect(
      frasesDoLoteDePausa({
        disabled: true,
        pedidos: 1,
        alterados: 0,
        jaEstavam: 0,
        arquivados: 1,
        falharam: [],
      }),
    ).toEqual({ sucesso: "Nada mudou: 1 canal arquivado fica de fora.", erro: null });
  });

  it("qualquer id em falharam mata a frase de sucesso", () => {
    const frases = frasesDoLoteDePausa({
      disabled: true,
      pedidos: 3,
      alterados: 3,
      jaEstavam: 0,
      arquivados: 0,
      falharam: [B],
    });
    expect(frases.sucesso).toBeNull();
    expect(frases.erro).toBe(`Não foi possível pausar 1 canal: ${B}. 3 canais pausados agora.`);
  });

  it("retomar fala em reativar, e o singular de uma conta só", () => {
    expect(
      frasesDoLoteDePausa({
        disabled: false,
        pedidos: 1,
        alterados: 1,
        jaEstavam: 0,
        arquivados: 0,
        falharam: [],
      }),
    ).toEqual({ sucesso: "Feito: 1 canal reativado agora.", erro: null });
    expect(
      frasesDoLoteDePausa({
        disabled: false,
        pedidos: 2,
        alterados: 0,
        jaEstavam: 2,
        arquivados: 0,
        falharam: [],
      }).sucesso,
    ).toBe("Nada mudou: 2 canais já estavam reativados.");
  });

  it("falha sem nada mudado não inventa conta: só os ids que não saíram", () => {
    expect(
      frasesDoLoteDePausa({
        disabled: true,
        pedidos: 2,
        alterados: 0,
        jaEstavam: 0,
        arquivados: 0,
        falharam: [A, C],
      }),
    ).toEqual({ sucesso: null, erro: `Não foi possível pausar 2 canais: ${A}, ${C}.` });
  });
});
