/**
 * O DIÁLOGO DA JORNADA: O BOTÃO COPIA NA TELA, E O RESUMO LÊ O QUE GRAVOU.
 *
 * ─── Por que um teste de tela, e não só a regra pura ───────────────────────
 *
 * `tests/unit/copiar-horarios-da-jornada.test.ts` guarda a regra. Este guarda
 * o FIO — dois call sites onde a regra podia estar certa e a tela continuar
 * errada, que é o defeito da issue #2312:
 *
 *   1. O botão "copiar estes horários para os outros dias úteis" existe, mas
 *      só mexe no estado local e ninguém o aciona? Aqui ele é CLICADO, e os
 *      dias-alvo têm de aparecer com as mesmas faixas na tela.
 *
 *   2. O resumo depois de salvar lendo o FORMULÁRIO em vez do RETORNO da
 *      gravação. É o mesmo defeito do bug original em outra roupa: a tela
 *      dizia uma semana, o banco guardava um dia. Por isso o caso abaixo
 *      devolve na gravação uma janela que NUNCA foi digitada (14:00–18:00) e
 *      uma digitada que NÃO foi gravada (20:00–22:00) — o resumo tem de
 *      mostrar a primeira e não a segunda.
 *
 *   3. "para a pessoa conferir ANTES DE SAIR": o diálogo não pode fechar sozinho
 *      no sucesso. Fechar e depois toast não deixa conferir nada.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ScheduleDialog } from "@/app/app/team/_components/AttendantsClient";
import type { AttendantAvailability } from "@/hooks/team/useAttendants";
import type { ScheduleWindow } from "@/lib/schemas/routing";

const NA_TELA = "America/Sao_Paulo";

function disponibilidade(windows: ScheduleWindow[]): AttendantAvailability {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    role: "agent",
    name: "Ana",
    email: "ana@exemplo.com.br",
    is_available: true,
    capacity: 5,
    schedule: { timezone: NA_TELA, windows },
    updated_at: "2026-10-01T12:00:00.000Z",
    current_load: 0,
    last_heartbeat_at: null,
    present: false,
  };
}

type Salvador = (windows: ScheduleWindow[], timezone: string) => Promise<ScheduleWindow[]>;

function abrir(windows: ScheduleWindow[], onSave: Salvador) {
  return render(
    <ScheduleDialog
      attendant={{ userId: "11111111-1111-4111-8111-111111111111", name: "Ana", email: null, availability: disponibilidade(windows) }}
      open
      onOpenChange={vi.fn()}
      onSave={onSave}
      isPending={false}
      organizationTimezone={NA_TELA}
    />,
  );
}

/** As faixas visíveis na tela, por dia — lido do rótulo e dos dois campos. */
function faixasNaTela(): Record<string, string[]> {
  const porDia: Record<string, string[]> = {};
  for (const linha of screen.getAllByTestId("janela")) {
    const dow = linha.getAttribute("data-dow") ?? "?";
    const inicio = linha.querySelector('input[aria-label="Início"]') as HTMLInputElement | null;
    const fim = linha.querySelector('input[aria-label="Fim"]') as HTMLInputElement | null;
    if (!inicio || !fim) continue;
    (porDia[dow] ??= []).push(`${inicio.value}–${fim.value}`);
  }
  return porDia;
}

describe("copiar estes horários para os outros dias úteis", () => {
  it("com horários na 2ª, os dias-alvo aparecem com as mesmas faixas", async () => {
    const user = userEvent.setup();
    abrir(
      [
        { dow: 1, start: "08:00", end: "11:30" },
        { dow: 1, start: "14:00", end: "18:00" },
      ],
      vi.fn(async () => []),
    );

    expect(faixasNaTela()["2"]).toBeUndefined();

    await user.click(screen.getByRole("button", { name: /copiar estes horários/i }));

    const naTela = faixasNaTela();
    for (const dow of ["2", "3", "4", "5"]) {
      expect(naTela[dow]).toEqual(["08:00–11:30", "14:00–18:00"]);
    }
    expect(naTela["1"]).toEqual(["08:00–11:30", "14:00–18:00"]);
  });
});

describe("resumo do que foi publicado", () => {
  it("lê o retorno da gravação e não o formulário, e fica antes de sair", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    /** O que o BANCO guardou: uma faixa que ninguém digitou, e sem a digitada. */
    const gravado: ScheduleWindow[] = [
      { dow: 1, start: "08:00", end: "11:30" },
      { dow: 1, start: "14:00", end: "18:00" },
    ];
    const onSave = vi.fn(async () => gravado);

    render(
      <ScheduleDialog
        attendant={{ userId: "11111111-1111-4111-8111-111111111111", name: "Ana", email: null, availability: disponibilidade([{ dow: 1, start: "08:00", end: "11:30" }, { dow: 1, start: "20:00", end: "22:00" }]) }}
        open
        onOpenChange={onOpenChange}
        onSave={onSave}
        isPending={false}
        organizationTimezone={NA_TELA}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    const resumo = await screen.findByTestId("resumo-publicado");
    expect(onSave).toHaveBeenCalledTimes(1);
    // Veio do retorno, não do formulário.
    expect(within(resumo).getByText("Seg 14:00–18:00")).toBeInTheDocument();
    // Ficou no formulário e NÃO foi gravado: não pode aparecer no resumo.
    expect(within(resumo).queryByText(/20:00/)).toBeNull();
    expect(within(resumo).getByText("Seg 08:00–11:30")).toBeInTheDocument();
    // Confere antes de sair: o diálogo continua aberto.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("gravando a semana inteira, o resumo lista os dias que o banco aceitou", async () => {
    const user = userEvent.setup();
    const gravado: ScheduleWindow[] = [1, 2, 3, 4, 5].map((dow) => ({
      dow,
      start: "08:00",
      end: "11:30",
    }));
    const onSave = vi.fn(async () => gravado);

    abrir([{ dow: 1, start: "08:00", end: "11:30" }], onSave);
    await user.click(screen.getByRole("button", { name: /copiar estes horários/i }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    const resumo = await screen.findByTestId("resumo-publicado");
    expect(within(resumo).getByText("Seg–Sex 08:00–11:30")).toBeInTheDocument();
  });

  it("mexer no rascunho depois do resumo devolve o Salvar — senão a edição some no Fechar", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (w: ScheduleWindow[]) => w);
    abrir([{ dow: 1, start: "08:00", end: "11:30" }], onSave);

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByTestId("resumo-publicado");
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();

    // A pessoa confere, vê só a segunda e corrige com o botão de copiar.
    await user.click(screen.getByRole("button", { name: /copiar estes horários/i }));
    expect(screen.getAllByTestId("janela")).toHaveLength(5);

    // O resumo falava do rascunho ANTERIOR: sai, e o Salvar volta.
    expect(screen.queryByTestId("resumo-publicado")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toHaveLength(5);
  });

  it("a região de status já está montada ANTES do resumo — é a mudança dentro dela que se anuncia", async () => {
    const user = userEvent.setup();
    abrir([{ dow: 1, start: "08:00", end: "11:30" }], vi.fn(async (w: ScheduleWindow[]) => w));

    const regiao = screen.getByRole("status");
    expect(regiao).toBeEmptyDOMElement();

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await screen.findByTestId("resumo-publicado");
    // A MESMA região de antes, agora com o conteúdo — não uma nova que nasceu cheia.
    expect(screen.getByRole("status")).toBe(regiao);
    expect(within(regiao).getByText("Seg 08:00–11:30")).toBeInTheDocument();
  });

  it("falhou a gravação não mostra resumo nenhum", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error("internal_error");
    });
    abrir([{ dow: 1, start: "08:00", end: "11:30" }], onSave);

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("resumo-publicado")).toBeNull();
  });
});
