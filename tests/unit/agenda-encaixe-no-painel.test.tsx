/**
 * O ENCAIXE PELA TELA — a porta que a regra do servidor não tinha.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * O PR #858 ensinou o servidor a aceitar, de uma PESSOA da equipe, um horário
 * fora da grade publicada (o cliente que só pode 10:30). A QA do lote 8 provou
 * pela tela que ninguém alcançava isso: a grade só habilita horário publicado, e
 * `PainelDeMarcacao` só lista os horários da rota. A capacidade existia e só se
 * usava chamando a API com o cookie da sessão
 * (`evidence/triagem-15set-l8/858-02-painel-oferece-so-hora-cheia.png`).
 *
 * ─── O que só a montagem prova ───────────────────────────────────────────
 *
 * 1. A opção é da AGENDA DA EQUIPE, não do painel: a vitrine monta o mesmo
 *    componente com dado de mentira, e a IA não marca fora da grade. Por isso
 *    ela depende de uma prop explícita, e o primeiro caso é a AUSÊNCIA dela.
 * 2. "10:30" é hora de PAREDE no fuso que o painel exibe, e vira instante por
 *    `instanteDe` — a mesma conversão do motor. Os casos cobrem um fuso negativo
 *    perto da meia-noite (23:45 em São Paulo já é o dia seguinte em UTC) e um
 *    positivo (00:30 em Tóquio ainda é a véspera em UTC). Os instantes esperados
 *    são literais escritos à mão, não recalculados pela mesma função.
 * 3. A recusa do servidor fica NO painel, com a mensagem dele, e o que a pessoa
 *    digitou continua lá para ela corrigir.
 *
 * O relógio é injetado e nenhum caso depende do fuso do processo: os dias do
 * calendário são datas de parede, e o instante sai do `fuso` da prop. Rodado com
 * `TZ=UTC` e `TZ=America/Sao_Paulo`.
 *
 *     npx vitest run tests/unit/agenda-encaixe-no-painel.test.tsx
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import type { HorarioLivre, Pessoa } from "@/components/agenda/tipos";
import { ApiError } from "@/lib/api/types";

afterEach(cleanup);

/** Terça, 15 de setembro de 2026, meio-dia — hora de parede do processo. */
const AGORA = new Date("2026-09-15T12:00:00");
const RESPONSAVEL: Pessoa = { id: "p1", nome: "Ana", trilha: 1 };

/** Quarta tem grade de hora cheia; domingo (20) não tem horário publicado. */
const HORARIOS: Record<string, HorarioLivre[]> = {
  "2026-09-16": [
    { instante: "2026-09-16T13:00:00.000Z", rotulo: "10:00" },
    { instante: "2026-09-16T14:00:00.000Z", rotulo: "11:00" },
  ],
};

type Props = Partial<ComponentProps<typeof PainelDeMarcacao>>;

function montar(sobre: Props = {}) {
  const onConfirmar = sobre.onConfirmar ?? vi.fn(async () => undefined);
  render(
    <PainelDeMarcacao
      ancora={AGORA}
      agora={AGORA}
      responsavel={RESPONSAVEL}
      fuso="America/Sao_Paulo"
      horariosPorDia={HORARIOS}
      {...sobre}
      onConfirmar={onConfirmar}
    />,
  );
  return { onConfirmar };
}

function painel() {
  return screen.getByTestId("painel-de-marcacao");
}

/** Dia → "Outro horário" (quando ela está recolhida) → hora → "Usar". */
function escolherEncaixe(dia: string, hora: string) {
  fireEvent.click(screen.getByTestId(`dia-${dia}`));
  const abrir = screen.queryByTestId("abrir-encaixe");
  if (abrir) fireEvent.click(abrir);
  fireEvent.change(screen.getByTestId("hora-do-encaixe"), { target: { value: hora } });
  fireEvent.click(screen.getByTestId("usar-hora-do-encaixe"));
}

describe("a opção existe só onde a prop a liga", () => {
  it("sem `permiteEncaixe` o painel é o de sempre: nenhuma porta, dia sem grade apagado", () => {
    montar();
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));

    expect(screen.queryByTestId("abrir-encaixe")).toBeNull();
    expect(screen.queryByTestId("hora-do-encaixe")).toBeNull();
    expect(screen.getByTestId("dia-2026-09-20")).toBeDisabled();
  });

  it("com a prop, o dia com grade oferece 'Outro horário' recolhido, abaixo dos horários", () => {
    montar({ permiteEncaixe: true });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));

    expect(screen.getByTestId("horario-10:00")).toBeInTheDocument();
    expect(screen.getByTestId("abrir-encaixe")).toHaveTextContent("Outro horário");
    expect(screen.queryByTestId("hora-do-encaixe")).toBeNull();
    const antes = screen.getByTestId("encaixe").compareDocumentPosition(screen.getByTestId("lista-de-horarios"));
    expect(antes & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("com a prop, o dia SEM horário publicado fica clicável e abre direto no campo de hora", () => {
    // O servidor aceita o encaixe em qualquer dia de quem publicou a jornada —
    // o domingo inclusive. Apagar esse dia seria a tela recusando o que a regra aceita.
    montar({ permiteEncaixe: true });
    const domingo = screen.getByTestId("dia-2026-09-20");

    expect(domingo).toBeEnabled();
    expect(domingo).toHaveAttribute("data-disponivel", "false");
    fireEvent.click(domingo);
    expect(screen.getByTestId("hora-do-encaixe")).toBeInTheDocument();
    expect(screen.getByTestId("encaixe")).toHaveTextContent("Nenhum horário publicado neste dia.");
    // Sem horários, o campo vem ANTES da lista vazia — que estica e o jogaria
    // para o pé da coluna, embaixo de um vão em branco.
    const depois = screen.getByTestId("encaixe").compareDocumentPosition(screen.getByTestId("lista-de-horarios"));
    expect(depois & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("dia que já passou continua apagado, com a prop ou sem ela", () => {
    montar({ permiteEncaixe: true });
    expect(screen.getByTestId("dia-2026-09-14")).toBeDisabled();
  });

  it("quem nunca publicou jornada não ganha o encaixe — o servidor recusaria", () => {
    montar({ permiteEncaixe: true, publicouHorarios: false, horariosPorDia: {} });

    expect(screen.getByTestId("sem-jornada-publicada")).toBeInTheDocument();
    expect(screen.getByTestId("dia-2026-09-16")).toBeDisabled();
    expect(screen.getByTestId("dia-2026-09-20")).toBeDisabled();
  });

  it("sem fuso conhecido não há como dizer que instante é '10:30' — a opção não aparece", () => {
    montar({ permiteEncaixe: true, fuso: undefined });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));

    expect(screen.queryByTestId("abrir-encaixe")).toBeNull();
    expect(screen.getByTestId("dia-2026-09-20")).toBeDisabled();
  });
});

describe("a hora digitada vira o instante no fuso que o painel exibe", () => {
  it.each([
    ["America/Sao_Paulo", "2026-09-16", "10:30", "2026-09-16T13:30:00.000Z"],
    // Perto da meia-noite, dos dois lados: o dia UTC não é o dia da parede.
    ["America/Sao_Paulo", "2026-09-16", "23:45", "2026-09-17T02:45:00.000Z"],
    ["America/Sao_Paulo", "2026-09-20", "00:15", "2026-09-20T03:15:00.000Z"],
    ["Asia/Tokyo", "2026-09-16", "00:30", "2026-09-15T15:30:00.000Z"],
  ])("%s, %s às %s → %s", async (fuso, dia, hora, esperado) => {
    const { onConfirmar } = montar({ permiteEncaixe: true, fuso });

    escolherEncaixe(dia, hora);
    expect(painel()).toHaveAttribute("data-tempo", "confirmando");

    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    await waitFor(() => expect(painel()).toHaveAttribute("data-tempo", "marcado"));
    expect(onConfirmar).toHaveBeenCalledTimes(1);
    expect(onConfirmar).toHaveBeenCalledWith(esperado);
  });

  it("sem hora digitada, 'Usar' fica desabilitado", () => {
    montar({ permiteEncaixe: true });
    fireEvent.click(screen.getByTestId("dia-2026-09-20"));
    expect(screen.getByTestId("usar-hora-do-encaixe")).toBeDisabled();
  });
});

describe("a recusa do servidor fica no painel", () => {
  const OCUPADO =
    "Este horário já está ocupado na agenda de quem atende — por outro compromisso ou pelo Google Agenda.";

  it("422 mostra a mensagem da rota, o painel não diz 'Marcado.' e a hora digitada fica", async () => {
    const onConfirmar = vi.fn(async () => {
      throw new ApiError(422, "agenda_horario_indisponivel", undefined, "req-1", OCUPADO);
    });
    montar({ permiteEncaixe: true, onConfirmar });

    escolherEncaixe("2026-09-16", "10:30");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    expect(await screen.findByTestId("recusa-da-marcacao")).toHaveTextContent(OCUPADO);
    expect(painel()).toHaveAttribute("data-tempo", "confirmando");
    expect(screen.queryByText("Marcado.")).toBeNull();
    expect(screen.getByTestId("hora-do-encaixe")).toHaveValue("10:30");

    // Voltar para corrigir não apaga o que ela digitou.
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(screen.getByTestId("hora-do-encaixe")).toHaveValue("10:30");
  });

  it("falha sem mensagem da rota (rede, 5xx) diz que não marcou, sem inventar motivo", async () => {
    const onConfirmar = vi.fn(async () => {
      throw new ApiError(500, "internal_error", undefined, "req-2", "HTTP 500");
    });
    montar({ permiteEncaixe: true, onConfirmar });

    escolherEncaixe("2026-09-16", "10:30");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    const recusa = await screen.findByTestId("recusa-da-marcacao");
    expect(recusa).toHaveTextContent("Não foi marcado. Tente de novo.");
    expect(recusa).not.toHaveTextContent("HTTP 500");
  });

  it("escolher outro horário tira a recusa do anterior da tela", async () => {
    const onConfirmar = vi.fn(async () => {
      throw new ApiError(422, "agenda_horario_indisponivel", undefined, "req-3", OCUPADO);
    });
    montar({ permiteEncaixe: true, onConfirmar });

    escolherEncaixe("2026-09-16", "10:30");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await screen.findByTestId("recusa-da-marcacao");

    fireEvent.click(screen.getByTestId("horario-11:00"));
    expect(screen.queryByTestId("recusa-da-marcacao")).toBeNull();
  });
});

describe("a confirmação é levada até a vista", () => {
  // De `lg` para cima o corpo rola e a confirmação nasce embaixo do mês, longe
  // de onde se clicou (a coluna de horários, o "Usar"). Sem rolar até ela, o
  // clique parece mudo — medido pela tela em 1280×800 e 1366×768.
  const original = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("escolher o horário do encaixe rola o bloco de confirmação, e a recusa rola de novo", async () => {
    const rolou = vi.fn();
    Element.prototype.scrollIntoView = rolou;
    const onConfirmar = vi.fn(async () => {
      throw new ApiError(422, "agenda_horario_indisponivel", undefined, "req-4", "Ocupado.");
    });
    montar({ permiteEncaixe: true, onConfirmar });

    escolherEncaixe("2026-09-16", "10:30");
    expect(rolou).toHaveBeenCalledWith({ block: "nearest" });
    expect(rolou.mock.contexts.at(-1)).toBe(screen.getByTestId("confirmacao"));

    const antes = rolou.mock.calls.length;
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await screen.findByTestId("recusa-da-marcacao");
    // `waitFor`, e não asserção direta: a rolagem mora num efeito, que roda DEPOIS
    // de a recusa estar no DOM. Medido: na suíte de agenda inteira (58 arquivos
    // em paralelo) o `findBy` resolvia antes do efeito e o caso reprovava.
    await waitFor(() => expect(rolou.mock.calls.length).toBeGreaterThan(antes));
    expect(rolou.mock.contexts.at(-1)).toBe(screen.getByTestId("confirmacao"));
  });
});
