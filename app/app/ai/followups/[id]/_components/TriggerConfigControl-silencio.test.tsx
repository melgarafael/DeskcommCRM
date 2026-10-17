/**
 * OS CONTROLES NOVOS DO GATILHO DE SILÊNCIO, PELA TELA.
 *
 * Renderização e interação em jsdom, com Testing Library: abre o painel, acha os
 * dois controles novos, mexe neles e mede O QUE SAI NO PATCH — que é o que
 * decide o comportamento do motor. Nenhum acesso a produção, nenhum serviço:
 * `apiClient` é falso e `sonner` também.
 *
 * ⚠️ O QUE ISTO **NÃO** É. Não é a prova do DoD 12. jsdom não tem layout: não há
 * pixel, não há recorte, não há sobreposição, não há foco real nem rolagem — e o
 * painel deste controle JÁ teve um defeito desses (o «Salvar gatilho» caindo
 * abaixo da dobra numa tela de 720 px, o que motivou a classe de rolagem no
 * `PopoverContent`). Esse tipo de defeito só aparece num navegador de verdade,
 * medido por `getBoundingClientRect`. O que estes casos provam é o CONTRATO da
 * tela: o campo existe, tem rótulo acessível, aceita o valor e grava o que
 * prometeu.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const patchMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    patch: (...a: unknown[]) => patchMock(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { TriggerConfigControl } from "./TriggerConfigControl";

/** Sem retry e sem cache entre casos: cada caso monta a tela do zero. */
function cliente() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

/** Identificadores SINTÉTICOS. Fixture nunca copia id do banco — ver `tests/unit/sem-identificador-de-producao.test.ts`. */
const FLUXO = "66666666-6666-4666-8666-666666666666";

/** O gatilho dos cinco fluxos da auditoria: silêncio cru, só com o limiar. */
const SILENCIO_CRU = { kind: "silence", params: { threshold_minutes: 180 } };

function montar(triggerConfig: Record<string, unknown> = SILENCIO_CRU) {
  return render(
    <QueryClientProvider client={cliente()}>
      <TriggerConfigControl flowId={FLUXO} triggerConfig={triggerConfig} />
    </QueryClientProvider>,
  );
}

/** Abre o painel do gatilho, como quem clica no botão. */
async function abrirPainel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("trigger-config-button"));
  return screen.getByTestId("trigger-config-panel");
}

/** O corpo do PATCH que a tela enviou. */
function corpoDoPatch(): Record<string, unknown> {
  expect(patchMock).toHaveBeenCalledTimes(1);
  const [, body] = patchMock.mock.calls[0]!;
  return (body as { trigger_config: Record<string, unknown> }).trigger_config;
}

function params(): Record<string, unknown> {
  return corpoDoPatch().params as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Etapas e funis: o painel os lê para o rótulo, e sem resposta a consulta fica
  // pendente para sempre e o `waitFor` abaixo expiraria por outro motivo.
  getMock.mockResolvedValue({ data: [] });
  patchMock.mockResolvedValue({ data: { id: FLUXO } });
});

describe("gatilho de silêncio · os dois controles novos aparecem", () => {
  it("o painel traz o teto de repetições e o interruptor de resposta da equipe", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    expect(screen.getByTestId("trigger-max-enrollments")).toBeInTheDocument();
    expect(screen.getByTestId("trigger-exige-resposta")).toBeInTheDocument();
  });

  it("cada um tem rótulo legível, e não só um testid", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    expect(
      screen.getByLabelText("Quantas vezes no máximo, por contato (opcional)"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Só começar se a equipe já respondeu a última mensagem do cliente"),
    ).toBeInTheDocument();
  });

  it("o teto nasce em 0 (sem limite) e o interruptor nasce desligado", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    expect(screen.getByTestId("trigger-max-enrollments")).toHaveValue(0);
    expect(screen.getByTestId("trigger-exige-resposta")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("o texto diz POR QUE o teto existe — a pausa só espaça, não encerra", async () => {
    const user = userEvent.setup();
    montar();
    const painel = await abrirPainel(user);

    expect(painel).toHaveTextContent(/a pausa acima só espaça os reinícios/i);
    expect(painel).toHaveTextContent(/para sempre/i);
  });

  it("o texto do interruptor explica que mensagem da equipe não zera a conta", async () => {
    const user = userEvent.setup();
    montar();
    const painel = await abrirPainel(user);

    expect(painel).toHaveTextContent(/mensagem da equipe não zera essa conta/i);
    expect(painel).toHaveTextContent(/quem está esperando resposta/i);
  });

  it("nenhum dos dois aparece em gatilho que não é de silêncio", async () => {
    const user = userEvent.setup();
    montar({ kind: "manual" });
    await abrirPainel(user);

    expect(screen.queryByTestId("trigger-max-enrollments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trigger-exige-resposta")).not.toBeInTheDocument();
  });
});

describe("gatilho de silêncio · o que a tela GRAVA", () => {
  it("teto 3 vira max_enrollments_por_contato: 3", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    const teto = screen.getByTestId("trigger-max-enrollments");
    await user.clear(teto);
    await user.type(teto, "3");
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(params().max_enrollments_por_contato).toBe(3);
  });

  it("interruptor ligado vira exige_resposta_da_equipe: true", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    await user.click(screen.getByTestId("trigger-exige-resposta"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(params().exige_resposta_da_equipe).toBe(true);
  });

  it("TETO ZERO não vai no fio — ausência é «sem limite», e 0 seria recusado pelo contrato", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    // Só mexe no interruptor, para o botão habilitar sem tocar no teto.
    await user.click(screen.getByTestId("trigger-exige-resposta"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(params()).not.toHaveProperty("max_enrollments_por_contato");
  });

  it("interruptor DESLIGADO não vai no fio — preserva o fluxo publicado de quem não o ligou", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    const teto = screen.getByTestId("trigger-max-enrollments");
    await user.clear(teto);
    await user.type(teto, "2");
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(params()).not.toHaveProperty("exige_resposta_da_equipe");
  });

  it("os dois juntos, e o limiar de sempre sobrevive ao salvamento", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    const teto = screen.getByTestId("trigger-max-enrollments");
    await user.clear(teto);
    await user.type(teto, "4");
    await user.click(screen.getByTestId("trigger-exige-resposta"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(corpoDoPatch().kind).toBe("silence");
    expect(params()).toMatchObject({
      threshold_minutes: 180,
      max_enrollments_por_contato: 4,
      exige_resposta_da_equipe: true,
    });
  });

  it("valor já salvo volta preenchido na reabertura (não se perde na ida e volta)", async () => {
    const user = userEvent.setup();
    montar({
      kind: "silence",
      params: {
        threshold_minutes: 1440,
        max_enrollments_por_contato: 5,
        exige_resposta_da_equipe: true,
      },
    });
    await abrirPainel(user);

    expect(screen.getByTestId("trigger-max-enrollments")).toHaveValue(5);
    expect(screen.getByTestId("trigger-exige-resposta")).toHaveAttribute("data-state", "checked");
  });

  it("sem mexer em nada, o botão de salvar fica travado (não reescreve o gatilho à toa)", async () => {
    const user = userEvent.setup();
    montar();
    await abrirPainel(user);

    expect(screen.getByTestId("trigger-config-save")).toBeDisabled();
    expect(patchMock).not.toHaveBeenCalled();
  });
});
