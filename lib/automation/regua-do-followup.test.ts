import { describe, expect, it } from "vitest";

import { prazosAtivosDasEtapas, reguaDoFollowup } from "./regua-do-followup";

/**
 * #3603 (fatia 4) — a régua por etapa, lida pelo motor.
 *
 * Este arquivo vigia a TRADUÇÃO entre o que a tela grava
 * (`settings.followup_por_etapa`, horas) e o que a varredura usa
 * (`automation_rules.trigger_config.dias`, dias). O que é puro mora aqui; a
 * precedência no lote de verdade está em
 * `tests/unit/regua-do-followup-no-motor.test.ts`.
 *
 * A tolerância é a MESMA do contrato da tela (`followupPorEtapaDeclarado`): o
 * jsonb é escrito por fora (script, seed, API antiga) e um valor torto vira
 * "sem régua" — nunca exceção, porque a varredura roda para todas as
 * organizações e uma linha torta não pode calar as irmãs.
 */

const ETAPA = "55555555-0000-4000-8000-000000000051";
const OUTRA_ETAPA = "55555555-0000-4000-8000-000000000052";
const FUNIL = "ffffffff-0000-4000-8000-0000000000f1";
const MENSAGEM = "Oi! Podemos tirar suas dúvidas por aqui?";

function settingsCom(mapa: Record<string, unknown>): unknown {
  return { followup_por_etapa: mapa, branding: { nome: "Ateliê" } };
}

describe("a régua de uma etapa", () => {
  it("ativa: devolve o prazo em HORAS, o texto e a etapa/funil que governaram", () => {
    const leitura = reguaDoFollowup(
      settingsCom({ [ETAPA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM } }),
      { pipelineId: FUNIL, stageId: ETAPA },
    );

    expect(leitura.motivo).toBeNull();
    expect(leitura.regua).toEqual({
      prazoHoras: 6,
      mensagem: MENSAGEM,
      stageId: ETAPA,
      pipelineId: FUNIL,
    });
  });

  it("mensagem ausente, nula ou em branco não impede o prazo", () => {
    for (const mensagem of [null, undefined, "", "   "]) {
      const leitura = reguaDoFollowup(
        settingsCom({ [ETAPA]: { ativa: true, prazo_horas: 6, mensagem } }),
        { pipelineId: FUNIL, stageId: ETAPA },
      );
      expect(leitura.regua?.prazoHoras, `mensagem ${JSON.stringify(mensagem)} derrubou o prazo`).toBe(6);
      expect(leitura.regua?.mensagem).toBeNull();
    }
  });

  it("o texto vem aparado — quem lê o payload não herda espaço de digitação", () => {
    const leitura = reguaDoFollowup(
      settingsCom({ [ETAPA]: { ativa: true, prazo_horas: 6, mensagem: `  ${MENSAGEM}  ` } }),
      { pipelineId: FUNIL, stageId: ETAPA },
    );
    expect(leitura.regua?.mensagem).toBe(MENSAGEM);
  });

  it("inativa: `null` com o motivo — e o prazo guardado não vaza", () => {
    const leitura = reguaDoFollowup(
      settingsCom({ [ETAPA]: { ativa: false, prazo_horas: 6, mensagem: MENSAGEM } }),
      { pipelineId: FUNIL, stageId: ETAPA },
    );

    expect(leitura.regua, "régua desligada continuou valendo: o interruptor da tela viraria enfeite").toBeNull();
    expect(leitura.motivo).toBe("regua_inativa");
  });

  it("etapa sem régua e negócio sem etapa: `null`, sem inventar prazo", () => {
    const settings = settingsCom({ [ETAPA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM } });

    expect(reguaDoFollowup(settings, { pipelineId: FUNIL, stageId: OUTRA_ETAPA })).toEqual({
      regua: null,
      motivo: "etapa_sem_regua",
    });
    expect(reguaDoFollowup(settings, { pipelineId: FUNIL, stageId: null })).toEqual({
      regua: null,
      motivo: "sem_etapa",
    });
  });

  it("ativa com prazo nulo é configuração INCOMPLETA, não régua de zero hora", () => {
    const leitura = reguaDoFollowup(
      settingsCom({ [ETAPA]: { ativa: true, prazo_horas: null, mensagem: MENSAGEM } }),
      { pipelineId: FUNIL, stageId: ETAPA },
    );

    expect(
      leitura,
      "prazo nulo virou 0 h: o card dispararia na hora em que entrasse na etapa",
    ).toEqual({ regua: null, motivo: "prazo_incompleto" });
  });
});

describe("a leitura é a mesma do contrato da tela — jsonb torto nunca lança", () => {
  it("prazo fora de 1..720 ou em texto vira null → incompleta, e não um prazo inventado", () => {
    for (const prazo_horas of ["6", 0, 721, 6.5, true, {}]) {
      const leitura = reguaDoFollowup(
        settingsCom({ [ETAPA]: { ativa: true, prazo_horas, mensagem: MENSAGEM } }),
        { pipelineId: FUNIL, stageId: ETAPA },
      );
      expect(leitura.regua, `prazo ${JSON.stringify(prazo_horas)} foi aceito como número`).toBeNull();
      expect(leitura.motivo).toBe("prazo_incompleto");
    }
  });

  it("`ativa` só liga com o booleano verdadeiro — a régua da chave, não a da string", () => {
    for (const ativa of ["true", 1, "sim", null]) {
      expect(
        reguaDoFollowup(settingsCom({ [ETAPA]: { ativa, prazo_horas: 6, mensagem: MENSAGEM } }), {
          pipelineId: FUNIL,
          stageId: ETAPA,
        }).regua,
        `ativa = ${JSON.stringify(ativa)} ligou a régua`,
      ).toBeNull();
    }
  });

  it("settings nulo, array, texto ou objeto sem a chave: sem régua, sem exceção", () => {
    const semMapa: unknown[] = [null, undefined, [], "settings", 42, {}, { followup_por_etapa: [] }, { followup_por_etapa: "mapa" }, { followup_por_etapa: null }];

    for (const settings of semMapa) {
      const leitura = reguaDoFollowup(settings, { pipelineId: FUNIL, stageId: ETAPA });
      expect(leitura.regua, `settings ${JSON.stringify(settings)} virou régua`).toBeNull();
      expect(leitura.motivo, `settings ${JSON.stringify(settings)}`).toBe("etapa_sem_regua");
    }
  });

  it("entrada torta no mapa é lida como DESLIGADA — é o padrão do `.catch` do contrato", () => {
    // `followupDaEtapaSchema.catch` devolve `{ ativa: false, ... }` para valor que
    // não é objeto: a etapa existe no mapa, mas não está ligada. O motor cai na
    // regra sem inventar prazo — e o motivo não é "sem régua", é "desligada".
    for (const entrada of ["regra", [], 7, true]) {
      const leitura = reguaDoFollowup(settingsCom({ [ETAPA]: entrada }), {
        pipelineId: FUNIL,
        stageId: ETAPA,
      });
      expect(leitura.regua, `entrada ${JSON.stringify(entrada)} virou régua`).toBeNull();
      expect(leitura.motivo, `entrada ${JSON.stringify(entrada)}`).toBe("regua_inativa");
    }
  });

  it("`stage_id` com nome de propriedade de objeto não é etapa", () => {
    const settings = settingsCom({ [ETAPA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM } });

    for (const stageId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(
        reguaDoFollowup(settings, { pipelineId: FUNIL, stageId }).regua,
        `${stageId} foi lido como etapa do mapa`,
      ).toBeNull();
    }
  });
});

describe("os prazos ativos que a varredura usa para não cortar cedo demais", () => {
  it("lista só as etapas ligadas E com prazo — é o menor deles que entra no corte do SQL", () => {
    const prazos = prazosAtivosDasEtapas(
      settingsCom({
        [ETAPA]: { ativa: true, prazo_horas: 6, mensagem: MENSAGEM },
        [OUTRA_ETAPA]: { ativa: true, prazo_horas: 48, mensagem: null },
        "55555555-0000-4000-8000-000000000053": { ativa: false, prazo_horas: 2, mensagem: null },
        "55555555-0000-4000-8000-000000000054": { ativa: true, prazo_horas: null, mensagem: null },
      }),
    );

    expect(
      prazos.map((p) => [p.stageId, p.prazoHoras]).sort(),
      "régua desligada ou sem prazo entrou no corte: o SQL passaria a varrer cedo por causa de uma etapa que não vale",
    ).toEqual([
      [ETAPA, 6],
      [OUTRA_ETAPA, 48],
    ]);
  });

  it("jsonb torto devolve lista vazia — e a varredura volta ao corte de hoje", () => {
    for (const settings of [null, {}, "x", { followup_por_etapa: [] }, { followup_por_etapa: null }]) {
      expect(prazosAtivosDasEtapas(settings)).toEqual([]);
    }
  });
});
