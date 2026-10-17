/**
 * OS AVISOS DE SEGURANÇA, APRESENTADOS AO PUBLICAR.
 *
 * `avisosDoGatilho` já é medido em `tests/unit/followup-teto-de-repeticoes-e-avisos.test.ts`
 * — ali se prova QUAIS avisos cada configuração rende. O que falta, e é o que
 * este arquivo mede, é a APRESENTAÇÃO: o que a pessoa vê quando clica em
 * Publicar. Um aviso que o servidor calcula e a tela engole não existe.
 *
 * ⚠️ NÃO é a prova do DoD 12: jsdom não renderiza o toast da `sonner` de
 * verdade (ela é falsa aqui), então isto prova que a tela PEDE o aviso, com o
 * texto certo e o tempo certo — não que ele apareceu legível na tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...a: unknown[]) => postMock(...a) },
}));

const sucesso = vi.fn();
const aviso = vi.fn();
const erro = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => sucesso(...a),
    warning: (...a: unknown[]) => aviso(...a),
    error: (...a: unknown[]) => erro(...a),
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { usePublishFollowupFlow } from "./useFollowupFlow";

/** Identificadores SINTÉTICOS. Fixture nunca copia id do banco — ver `tests/unit/sem-identificador-de-producao.test.ts`. */
const FLUXO = "66666666-6666-4666-8666-666666666666";

function envoltorio({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Os três avisos como o servidor os devolve para um fluxo de silêncio cru. */
const TRES_AVISOS = [
  {
    code: "silencio_sem_teto",
    message:
      "Sem “silêncio máximo”, o fluxo alcança TODO contato calado há mais que o mínimo — inclusive quem sumiu há meses — e começa para todos eles na primeira varredura, um minuto depois de publicar.",
  },
  {
    code: "silencio_sem_limite_de_repeticoes",
    message:
      "Sem limite de repetições, a pausa só ESPAÇA os reinícios: quem nunca responde volta a receber o fluxo a cada pausa, indefinidamente.",
  },
  {
    code: "silencio_alcanca_nao_atendido",
    message:
      "O silêncio conta da última mensagem do CLIENTE, e mensagem da equipe não zera essa conta: quem escreveu e não foi atendido também entra no fluxo. Ligue “Só começar se a equipe já respondeu a última mensagem do cliente” se o fluxo é para quem sumiu, não para quem está esperando.",
  },
];

async function publicar(resposta: unknown) {
  postMock.mockResolvedValue({ data: resposta });
  const { result } = renderHook(() => usePublishFollowupFlow(FLUXO), { wrapper: envoltorio });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

beforeEach(() => vi.clearAllMocks());

describe("avisos na publicação", () => {
  it("fluxo de silêncio cru: os TRÊS avisos são mostrados, um por um", async () => {
    await publicar({ id: FLUXO, status: "active", avisos: TRES_AVISOS });

    expect(aviso).toHaveBeenCalledTimes(3);
    const mostrados = aviso.mock.calls.map((c) => c[0] as string);
    expect(mostrados[0]).toContain("silêncio máximo");
    expect(mostrados[1]).toContain("Sem limite de repetições");
    expect(mostrados[2]).toContain("mensagem da equipe não zera essa conta");
  });

  it("o «Fluxo publicado.» continua aparecendo — o aviso não substitui o sucesso", async () => {
    await publicar({ id: FLUXO, avisos: TRES_AVISOS });

    expect(sucesso).toHaveBeenCalledWith("Fluxo publicado.");
    expect(erro).not.toHaveBeenCalled();
  });

  it("cada aviso fica 12 s na tela — a frase é longa e diz o que fazer", async () => {
    await publicar({ id: FLUXO, avisos: TRES_AVISOS });

    for (const chamada of aviso.mock.calls) {
      expect(chamada[1]).toEqual({ duration: 12_000 });
    }
  });

  it("fluxo com os três knobs preenchidos: publica sem aviso nenhum", async () => {
    await publicar({ id: FLUXO, avisos: [] });

    expect(aviso).not.toHaveBeenCalled();
    expect(sucesso).toHaveBeenCalledWith("Fluxo publicado.");
  });

  it("apenas UM aviso pendente: só ele é mostrado", async () => {
    await publicar({ id: FLUXO, avisos: [TRES_AVISOS[1]] });

    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso.mock.calls[0]![0]).toContain("Sem limite de repetições");
  });

  it("resposta SEM o campo avisos (servidor antigo) não quebra nem inventa aviso", async () => {
    await publicar({ id: FLUXO, status: "active" });

    expect(aviso).not.toHaveBeenCalled();
    expect(sucesso).toHaveBeenCalledWith("Fluxo publicado.");
    expect(erro).not.toHaveBeenCalled();
  });

  it("gatilho que não é de silêncio: o servidor manda lista vazia e a tela fica quieta", async () => {
    await publicar({ id: FLUXO, avisos: [] });

    expect(aviso).not.toHaveBeenCalled();
  });
});
