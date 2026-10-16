import { describe, expect, it } from "vitest";

import type { Lead } from "@/lib/types/leads";

import { anexarTarefasAosNegocios, type LinhaDaTarefaNoQuadro } from "./tarefas-no-quadro";

const AGORA = new Date("2026-10-11T12:00:00-03:00");
const ONTEM = "2026-10-10T09:00:00-03:00";
const AMANHA = "2026-10-12T09:00:00-03:00";

const lead = (id: string): Lead => ({ id }) as Lead;

const tarefa = (
  lead_id: string | null,
  resto: Partial<LinhaDaTarefaNoQuadro> = {},
): LinhaDaTarefaNoQuadro => ({ lead_id, due_date: null, status: "pending", ...resto });

describe("anexarTarefasAosNegocios — o selo de tarefas do card", () => {
  it("⭐ conta as abertas e, entre elas, as que passaram do prazo", () => {
    const [negocio] = anexarTarefasAosNegocios(
      [lead("l1")],
      [
        tarefa("l1", { due_date: ONTEM }),
        tarefa("l1", { due_date: AMANHA, status: "in_progress" }),
        tarefa("l1"),
      ],
      AGORA,
    );

    expect(negocio?.tarefas).toEqual({ abertas: 3, atrasadas: 1 });
  });

  it("encerrada não conta — nem a concluída, nem a cancelada com prazo vencido", () => {
    const [negocio] = anexarTarefasAosNegocios(
      [lead("l1")],
      [
        tarefa("l1", { due_date: AMANHA }),
        tarefa("l1", { due_date: ONTEM, status: "done" }),
        tarefa("l1", { due_date: ONTEM, status: "cancelled" }),
      ],
      AGORA,
    );

    expect(negocio?.tarefas).toEqual({ abertas: 1, atrasadas: 0 });
  });

  it("negócio só com tarefas encerradas não ganha selo de zero", () => {
    const [negocio] = anexarTarefasAosNegocios(
      [lead("l1")],
      [tarefa("l1", { status: "done" })],
      AGORA,
    );

    expect(negocio).not.toHaveProperty("tarefas");
  });

  it("cada negócio conta só as SUAS; tarefa avulsa (sem negócio) não entra em card nenhum", () => {
    const negocios = anexarTarefasAosNegocios(
      [lead("l1"), lead("l2"), lead("l3")],
      [tarefa("l1"), tarefa("l2", { due_date: ONTEM }), tarefa("l2"), tarefa(null)],
      AGORA,
    );

    expect(negocios.map((n) => n.tarefas)).toEqual([
      { abertas: 1, atrasadas: 0 },
      { abertas: 2, atrasadas: 1 },
      undefined,
    ]);
  });

  it("sem linha nenhuma devolve a MESMA lista (o quadro não recria os objetos à toa)", () => {
    const leads = [lead("l1")];
    expect(anexarTarefasAosNegocios(leads, [], AGORA)).toBe(leads);
  });
});
