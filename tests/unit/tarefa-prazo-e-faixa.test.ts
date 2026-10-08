/**
 * A REGRA DE PRAZO DA TAREFA, com o relógio FIXO.
 *
 * Duas coisas que o original (PR #418) fazia e que se medem aqui:
 *
 *   1. Ele decidia a faixa com `new Date()` lido lá dentro. Um caso de "vence
 *      hoje às 23h" fica verde de manhã e vermelho à noite — teste que muda de
 *      resposta com a hora da rodada não vigia nada. Por isso `agora` é
 *      parâmetro.
 *   2. Ele lia o dia do calendário com `due_date.slice(0, 10)`, que é o dia em
 *      UTC. O caso de 31/12 às 21h em Brasília está abaixo, e ele reprova a
 *      versão antiga.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agrupaPorPrazo,
  diaLocalDoPrazo,
  estaAtrasada,
  estaEncerrada,
  faixaDePrazo,
  proximoEstadoAoAlternar,
  type Tarefa,
} from "@/lib/tarefas/tipos";

/** Quarta-feira, 2026-09-02, 10:00 local. */
const AGORA = new Date(2026, 8, 2, 10, 0, 0);

function tarefa(p: Partial<Tarefa>): Tarefa {
  return {
    id: "t",
    organization_id: "o",
    title: "t",
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: null,
    contact_id: null,
    assigned_to: null,
    created_by: null,
    created_at: AGORA.toISOString(),
    updated_at: AGORA.toISOString(),
    ...p,
  };
}

/** ISO com o offset LOCAL da máquina — é assim que o navegador manda o prazo. */
function local(ano: number, mes: number, dia: number, hora = 9, min = 0): string {
  return new Date(ano, mes - 1, dia, hora, min, 0).toISOString();
}

describe("prazo da tarefa", () => {
  it("sem prazo nunca está atrasada — a coluna é nullable de propósito", () => {
    expect(estaAtrasada(tarefa({ due_date: null }), AGORA)).toBe(false);
    expect(faixaDePrazo(tarefa({ due_date: null }), AGORA)).toBe("sem_prazo");
  });

  it("prazo vencido e ainda aberta está atrasada", () => {
    expect(estaAtrasada(tarefa({ due_date: local(2026, 9, 1) }), AGORA)).toBe(true);
  });

  it("encerrada não atrasa, mesmo com o prazo vencido", () => {
    // Senão a lista de atrasadas encheria de coisa que já foi feita, e ela
    // deixaria de ser lida — que é como um alerta morre.
    for (const status of ["done", "cancelled"] as const) {
      expect(estaAtrasada(tarefa({ due_date: local(2026, 9, 1), status }), AGORA)).toBe(false);
      expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 1), status }), AGORA)).toBe("encerrada");
    }
  });

  it("hoje mais cedo AINDA é hoje, não 'atrasada' — a faixa é do DIA", () => {
    // Às 10h, uma tarefa das 8h está tecnicamente vencida...
    expect(estaAtrasada(tarefa({ due_date: local(2026, 9, 2, 8) }), AGORA)).toBe(true);
    // ...mas a lista a mostra em "Hoje": mandar para "Atrasadas" o que ainda dá
    // para fazer hoje transforma o grupo urgente em ruído toda manhã.
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 2, 8) }), AGORA)).toBe("hoje");
  });

  it("as faixas cobrem a semana e o depois", () => {
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 4) }), AGORA)).toBe("esta_semana");
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 8) }), AGORA)).toBe("esta_semana");
    expect(faixaDePrazo(tarefa({ due_date: local(2026, 9, 30) }), AGORA)).toBe("mais_tarde");
  });

  it("o agrupamento sai na ordem da tela e não devolve grupo vazio", () => {
    const grupos = agrupaPorPrazo(
      [
        tarefa({ id: "a", due_date: local(2026, 9, 30) }),
        tarefa({ id: "b", due_date: local(2026, 9, 1) }),
        tarefa({ id: "c", due_date: local(2026, 9, 2, 15) }),
      ],
      AGORA,
    );
    expect(grupos.map((g) => g.faixa)).toEqual(["atrasada", "hoje", "mais_tarde"]);
    expect(grupos.flatMap((g) => g.tarefas.map((t) => t.id))).toEqual(["b", "c", "a"]);
  });
});

describe("o dia do calendário é o dia de QUEM OLHA", () => {
  /**
   * ⚠️ O FUSO É FIXADO AQUI, e sem isto o caso abaixo não mede nada.
   *
   * O CI roda em UTC. Em UTC, `2026-12-31T21:00` local É `2026-12-31T21:00Z`, o
   * recorte do ISO acerta por coincidência, e o teste ficaria verde sobre o
   * defeito que ele existe para prender. Fixar o fuso é o que torna a asserção
   * a mesma na máquina de quem escreve e no runner.
   */
  const fusoOriginal = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Sao_Paulo";
  });
  afterAll(() => {
    if (fusoOriginal === undefined) delete process.env.TZ;
    else process.env.TZ = fusoOriginal;
  });

  it("prazo à noite não pula para o dia seguinte", () => {
    // `2026-12-31T21:00` em Brasília é `2027-01-01T00:00Z`. Com o recorte do
    // ISO em UTC — que era o do original — a tarefa marcada para 31 de dezembro
    // desaparecia do mês de dezembro e reaparecia em janeiro.
    const iso = local(2026, 12, 31, 21);
    expect(diaLocalDoPrazo(iso)).toBe("2026-12-31");
    expect(diaLocalDoPrazo(iso)).not.toBe(iso.slice(0, 10));
  });

  it("prazo de manhã também casa com o próprio dia", () => {
    expect(diaLocalDoPrazo(local(2026, 3, 5, 9))).toBe("2026-03-05");
  });
});

/**
 * #2549 — a caixa "Reabrir a tarefa" numa tarefa CANCELADA gravava `done`.
 *
 * A caixa da lista é pintada por `estaEncerrada` (cancelada = encerrada, caixa
 * marcada, rótulo "Reabrir"), mas o cliente decidia o próximo status olhando
 * só `done`. Dois códigos dizendo o que é "encerrada": o clique reabria para
 * CONCLUÍDA e a rota registrava "Tarefa concluída" na linha do tempo. A regra
 * agora é uma função pura só, e é ela que este bloco prende.
 */
describe("alternar a caixa da lista (#2549)", () => {
  it("cancelada reabre para pendente — NUNCA para concluída", () => {
    // Previsto na `main` antiga: `cancelled` não era `done`, a condição caía no
    // ramo falso e o PATCH saía com {"status":"done"}. Medido aqui: `pending`.
    expect(proximoEstadoAoAlternar("cancelled")).toBe("pending");
    expect(proximoEstadoAoAlternar("cancelled")).not.toBe("done");
  });

  it("concluída reabre para pendente — o caso que já funcionava", () => {
    expect(proximoEstadoAoAlternar("done")).toBe("pending");
  });

  it("o que ainda pede ação vira concluída", () => {
    expect(proximoEstadoAoAlternar("pending")).toBe("done");
    expect(proximoEstadoAoAlternar("in_progress")).toBe("done");
  });

  it("a caixa e o cliente partilham a MESMA regra do que é encerrada", () => {
    // Se a função voltar a divergir de `estaEncerrada`, a tela mostra
    // "Reabrir a tarefa" e o cliente grava outra coisa — que era o defeito.
    for (const status of ["pending", "in_progress", "done", "cancelled"] as const) {
      const proximo = proximoEstadoAoAlternar(status);
      const reabriu = proximo === "pending";
      expect(reabriu).toBe(estaEncerrada({ status }));
    }
  });
});
