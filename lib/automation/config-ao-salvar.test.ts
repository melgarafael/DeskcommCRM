/**
 * O QUE A TELA DESCONHECE SOBREVIVE AO SALVAR (issue #2483).
 *
 * A regra criada pela API com `trigger_config: { dias, pipeline_id, stage_id }`
 * perdia os dois filtros no primeiro "salvar" dado pela tela — o editor
 * reconstruía o objeto só com o que desenha. Sem o filtro, a varredura
 * `lead-time-triggers` passa a valer para TODOS os funis: a regra dispara onde
 * ninguém pediu, em silêncio.
 *
 * Aqui moram os casos de borda da função pura. O call site — o `onSubmit` do
 * editor de verdade, com o gesto de clicar em Salvar — é medido pelo irmão
 * `tests/unit/rule-editor-preserva-config-ao-salvar.test.tsx`: teste de função
 * pura que passasse com o editor chamando outra coisa não provaria nada.
 */
import { describe, expect, it } from "vitest";

import { configAoSalvarDaTela } from "./config-ao-salvar";
import { GATILHO_ETAPA_PARADA, GATILHO_SILENCIO } from "./gatilhos-de-tempo";
import { GATILHO_DE_DATA_DO_FUNIL } from "./gatilho-de-data-do-funil";

/** O caso da issue: a regra da API, com 45 dias, funil e etapa gravados. */
const GUARDADA_DA_ETAPA = {
  dias: 45,
  pipeline_id: "11111111-1111-4111-8111-111111111111",
  stage_id: "22222222-2222-4222-8222-222222222222",
  proteger_pela_agenda: false,
};

describe("a regra salva pela tela mantém o filtro que a tela não edita", () => {
  it("⭐ etapa parada: `pipeline_id` e `stage_id` sobrevivem ao salvar", () => {
    const saida = configAoSalvarDaTela({
      gatilhoDaRegra: GATILHO_ETAPA_PARADA,
      configDaRegra: GUARDADA_DA_ETAPA,
      gatilhoDaTela: GATILHO_ETAPA_PARADA,
      configDaTela: { dias: 45, proteger_pela_agenda: false },
    });

    expect(saida.pipeline_id, "o funil sumiu: a regra passa a valer para todos").toBe(
      GUARDADA_DA_ETAPA.pipeline_id,
    );
    expect(saida.stage_id, "a etapa sumiu: a regra passa a valer para todo card parado").toBe(
      GUARDADA_DA_ETAPA.stage_id,
    );
    expect(saida.dias).toBe(45);
  });

  it("silêncio: o `pipeline_id` sobrevive ao salvar", () => {
    const saida = configAoSalvarDaTela({
      gatilhoDaRegra: GATILHO_SILENCIO,
      configDaRegra: { dias: 7, direcao: "do_cliente", pipeline_id: "funil-1", proteger_pela_agenda: true },
      gatilhoDaTela: GATILHO_SILENCIO,
      configDaTela: { dias: 7, direcao: "do_cliente", proteger_pela_agenda: true },
    });

    expect(saida.pipeline_id).toBe("funil-1");
  });

  it("a tela manda no que ela edita (par de vacuidade)", () => {
    // Sem este caso, uma função que ignorasse `configDaTela` e devolvesse a
    // guardada inteira passaria nos dois acima — provando o contrário do que
    // eles querem provar.
    const saida = configAoSalvarDaTela({
      gatilhoDaRegra: GATILHO_ETAPA_PARADA,
      configDaRegra: GUARDADA_DA_ETAPA,
      gatilhoDaTela: GATILHO_ETAPA_PARADA,
      configDaTela: { dias: 30, proteger_pela_agenda: true },
    });

    expect(saida.dias).toBe(30);
    expect(saida.proteger_pela_agenda).toBe(true);
    expect(saida.pipeline_id).toBe(GUARDADA_DA_ETAPA.pipeline_id);
  });
});

describe("a herança não atravessa gatilhos nem inventa configuração", () => {
  it("trocar o gatilho descarta o objeto antigo — chave do outro gatilho não herda significado", () => {
    // `dias` do silêncio não é `dias` da data; herdar `pipeline_id`/`stage_id`
    // de um para outro seria gravar configuração que ninguém escolheu.
    const saida = configAoSalvarDaTela({
      gatilhoDaRegra: GATILHO_ETAPA_PARADA,
      configDaRegra: GUARDADA_DA_ETAPA,
      gatilhoDaTela: GATILHO_DE_DATA_DO_FUNIL,
      configDaTela: { pipeline_id: "funil-2", campo: "data_assinatura", dias: 3 },
    });

    expect(saida).toEqual({ pipeline_id: "funil-2", campo: "data_assinatura", dias: 3 });
  });

  it("regra nova grava só o que a tela escolheu", () => {
    const saida = configAoSalvarDaTela({
      gatilhoDaRegra: null,
      configDaRegra: null,
      gatilhoDaTela: GATILHO_SILENCIO,
      configDaTela: { dias: 7, direcao: "da_equipe", proteger_pela_agenda: false },
    });

    expect(saida).toEqual({ dias: 7, direcao: "da_equipe", proteger_pela_agenda: false });
  });

  it("configuração guardada torta (string, lista, null) não derruba o salvar", () => {
    // A coluna é jsonb: um valor que não é objeto é dado de fora, e a tela não
    // pode estourar por causa dele — grava o que conhece e segue.
    for (const torta of ["texto", [1, 2], 42, null, undefined]) {
      const saida = configAoSalvarDaTela({
        gatilhoDaRegra: GATILHO_ETAPA_PARADA,
        configDaRegra: torta,
        gatilhoDaTela: GATILHO_ETAPA_PARADA,
        configDaTela: { dias: 10, proteger_pela_agenda: false },
      });
      expect(saida, JSON.stringify(torta)).toEqual({ dias: 10, proteger_pela_agenda: false });
    }
  });
});
