/**
 * "NÃO ATENDER EM FERIADO NACIONAL" NA TELA DO AGENTE (#3877, doc 316 A).
 *
 * A opção mora no bloco do horário de funcionamento, ao lado das mensagens de
 * fora do horário. Vem DESLIGADA: quem liga o horário sem mexer nela grava o
 * bloco sem a chave, e a leitura do turno (`lerFechadoEmFeriadoNacional`) trata
 * ausente como desligada — o feriado continua um dia comum.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  TriggerEditor,
  type TriggerValue,
} from "@/app/app/ai/agents/[id]/_components/TriggerEditor";

const COM_HORARIO: TriggerValue = {
  events: ["message"],
  filters: {
    ignore_groups: true,
    ignore_self: true,
    keyword_regex: null,
    business_hours: {
      timezone: "America/Sao_Paulo",
      start: "08:00",
      end: "18:00",
      weekdays: [1, 2, 3, 4, 5],
    },
  },
  concurrency: "one_per_conversation",
};

describe("tela do agente: não atender em feriado nacional", () => {
  it("vem desligada", () => {
    render(<TriggerEditor value={COM_HORARIO} onChange={vi.fn()} />);

    expect(screen.getByLabelText("Não atender em feriado nacional")).not.toBeChecked();
  });

  it("ligar grava a chave no horário de funcionamento, sem mexer no resto", () => {
    const onChange = vi.fn();
    render(<TriggerEditor value={COM_HORARIO} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Não atender em feriado nacional"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitido = onChange.mock.calls[0]![0] as TriggerValue;
    expect(emitido.filters.business_hours).toEqual({
      ...COM_HORARIO.filters.business_hours,
      fechado_em_feriado_nacional: true,
    });
  });

  it("sem horário de funcionamento, a opção não aparece", () => {
    render(
      <TriggerEditor
        value={{ ...COM_HORARIO, filters: { ...COM_HORARIO.filters, business_hours: null } }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Não atender em feriado nacional")).toBeNull();
  });
});
