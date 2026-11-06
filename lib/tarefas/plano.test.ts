import { describe, expect, it } from "vitest";

import { lePlanosDoSettings } from "./plano";

/**
 * PLANOS DE TAREFA (#1752) — a LEITURA da configuração.
 *
 * `organizations.settings.task_plans` é JSON escrito por gente: a leitura tem
 * de devolver só os planos válidos, na ordem declarada, e nunca lançar. Esse é
 * o contrato que este arquivo vigia.
 *
 * ⌛ A APLICAÇÃO do plano saiu daqui na #3715. Os casos que moravam nesta parte
 * (3 tarefas na ordem com prazo relativo, idempotência pela marca, recusa de
 * `sem_dono`/`titulo_vazio` ANTES do primeiro INSERT, e o negócio de outra
 * organização) rodavam contra um banco falso que imitava a CADEIA do
 * PostgREST. O domínio agora fala SQL com parâmetros, e cadeia falsa não prova
 * nada sobre SQL: os mesmos casos — com mais um de isolamento entre
 * organizações — foram reescritos contra Postgres de verdade em
 * `tests/invariants/tarefas-piloto-pg.test.ts`.
 */
const PLANO = "plano-proposta-enviada";
const OUTRO = "77777777-0000-4000-8000-000000000007";

const PLANO_3_PASSOS = {
  id: PLANO,
  nome: "Proposta enviada",
  descricao: "Sequência de retorno da proposta comercial",
  passos: [
    {
      ordem: 1,
      titulo: "Agradecer a proposta de {{lead.title}}",
      vence_em_dias: 0,
      prioridade: "high",
      atribuir_a: "dono_do_lead",
    },
    {
      ordem: 2,
      titulo: "Ligar para conferir o recebimento",
      vence_em_dias: 2,
      prioridade: "medium",
      atribuir_a: "dono_do_lead",
    },
    {
      ordem: 3,
      titulo: "Enviar o caso de sucesso",
      vence_em_dias: 5,
      prioridade: "low",
      atribuir_a: { usuario_id: OUTRO },
    },
  ],
};

describe("lePlanosDoSettings", () => {
  it("lê a lista gravada em organizations.settings.task_plans e ignora o que for torto", () => {
    const planos = lePlanosDoSettings({
      task_plans: [
        PLANO_3_PASSOS,
        { nome: "Sem id", passos: [] },
        "não é um plano",
        { id: "ok", nome: "Simples", passos: [{ titulo: "Único", vence_em_dias: 1 }] },
      ],
    });

    expect(planos.map((p) => p.id)).toEqual([PLANO, "ok"]);
    // Passo sem `ordem` ganha a posição dele na lista — a ordem é lida, não improvisada.
    expect(planos[0]?.passos.map((p) => p.ordem)).toEqual([1, 2, 3]);
    expect(planos[1]?.passos[0]).toMatchObject({ ordem: 1, prioridade: "medium" });
  });

  it("settings ausente ou inválido devolve lista vazia (nunca lança)", () => {
    expect(lePlanosDoSettings(undefined)).toEqual([]);
    expect(lePlanosDoSettings({ task_plans: "lixo" })).toEqual([]);
    expect(lePlanosDoSettings(null)).toEqual([]);
  });
});
