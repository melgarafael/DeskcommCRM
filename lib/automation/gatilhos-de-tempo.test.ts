import { describe, expect, it } from "vitest";

import {
  DIRECOES_DO_SILENCIO,
  GATILHO_ETAPA_PARADA,
  GATILHO_SILENCIO,
  ancoraDaEtapa,
  ancoraDoSilencio,
  chaveDeDisparoTemporal,
  colunaDaDirecao,
  configDaEtapaParada,
  configDoSilencio,
  naoDisparadosTemporais,
} from "./gatilhos-de-tempo";

/**
 * #1540 — os gatilhos por TEMPO.
 *
 * O que ESTE arquivo vigia é a regra do rearme: uma vez por EPISÓDIO, e a
 * âncora é o que define o episódio. É a diferença entre "cria UMA tarefa quando
 * o lead fica 7 dias sem mensagem da equipe e NÃO cria outra até haver nova
 * mensagem e novo silêncio" (critério de aceite) e a trava para sempre que o
 * `lead.date_field_due` tinha.
 */

const AGORA = new Date("2026-09-25T12:00:00.000Z");
const dias = (n: number) => new Date(AGORA.getTime() - n * 86_400_000).toISOString();

describe("a configuração dos dois gatilhos", () => {
  it("lê silêncio completo e aplica os padrões", () => {
    expect(configDoSilencio({ dias: 7, direcao: "da_equipe" })).toEqual({
      dias: 7,
      direcao: "da_equipe",
      pipeline_id: null,
      proteger_pela_agenda: false,
    });
  });

  it("aceita as três direções e recusa qualquer outra", () => {
    for (const direcao of DIRECOES_DO_SILENCIO) {
      expect(configDoSilencio({ dias: 3, direcao })?.direcao).toBe(direcao);
    }
    expect(configDoSilencio({ dias: 3, direcao: "do_cliente_e_outros" })).toBeNull();
  });

  it("recusa linha torta em vez de estourar — a varredura roda para todas as orgs", () => {
    expect(configDoSilencio(null)).toBeNull();
    expect(configDoSilencio({})).toBeNull();
    expect(configDoSilencio({ dias: 0, direcao: "qualquer" })).toBeNull();
    expect(configDoSilencio({ dias: 7.5, direcao: "qualquer" })).toBeNull();
    expect(configDaEtapaParada({ dias: 30.5 })).toBeNull();
    // Funil em branco NÃO é linha torta: é "todos os funis" (`null`), que é o
    // que a varredura usa para não recortar.
    expect(configDaEtapaParada({ dias: 30, pipeline_id: " " })?.pipeline_id).toBeNull();
    expect(configDaEtapaParada({ dias: 30, pipeline_id: "p1", proteger_pela_agenda: true })).toEqual({
      dias: 30,
      pipeline_id: "p1",
      stage_id: null,
      proteger_pela_agenda: true,
    });
  });

  it("os nomes dos gatilhos são os que a varredura e a tela usam", () => {
    expect(GATILHO_SILENCIO).toBe("lead.silent_for");
    expect(GATILHO_ETAPA_PARADA).toBe("lead.stage_stale");
  });

  it("cada direção aponta para a coluna certa de conversations", () => {
    expect(colunaDaDirecao("da_equipe")).toBe("last_outbound_at");
    expect(colunaDaDirecao("do_cliente")).toBe("last_inbound_at");
    expect(colunaDaDirecao("qualquer")).toBe("last_message_at");
  });
});

describe("a âncora do silêncio — quando o relógio zera", () => {
  it("cumpre N dias a partir da ÚLTIMA mensagem da direção", () => {
    expect(ancoraDoSilencio(dias(7), dias(30), AGORA, 7)).toBe(dias(7));
    expect(ancoraDoSilencio(dias(6.9), dias(30), AGORA, 7)).toBeNull();
  });

  it("contato que nunca falou conta do NASCIMENTO do negócio", () => {
    expect(ancoraDoSilencio(null, dias(8), AGORA, 7)).toBe(dias(8));
    // Lead de ontem sem mensagem não é lead parado há 7 dias.
    expect(ancoraDoSilencio(null, dias(1), AGORA, 7)).toBeNull();
  });
});

describe("a âncora da etapa parada", () => {
  it("dispara quando o card não anda há N dias", () => {
    expect(ancoraDaEtapa(dias(10), AGORA, 7)).toBe(dias(10));
    expect(ancoraDaEtapa(dias(2), AGORA, 7)).toBeNull();
  });

  it("linha sem carimbo não vira disparo — espera o próximo carimbo", () => {
    expect(ancoraDaEtapa(null, AGORA, 7)).toBeNull();
    expect(ancoraDaEtapa("não é data", AGORA, 7)).toBeNull();
  });
});

describe("a trava: uma vez por episódio, e o rearme quando a âncora muda", () => {
  it("a mesma âncora não dispara duas vezes", () => {
    const emitidos = new Set([chaveDeDisparoTemporal("r1", "l1", dias(7))]);
    const candidatos = [{ leadId: "l1", ancora: dias(7) }];
    expect(naoDisparadosTemporais(candidatos, emitidos, "r1")).toEqual([]);
  });

  it("mensagem nova muda a âncora: o mesmo par volta a ser elegível", () => {
    // O lead falou ontem; o silêncio de 7 dias acabou de completar de novo.
    const emitidos = new Set([chaveDeDisparoTemporal("r1", "l1", dias(30))]);
    const candidatos = [{ leadId: "l1", ancora: dias(7) }];
    expect(naoDisparadosTemporais(candidatos, emitidos, "r1")).toEqual(candidatos);
  });

  it("a trava é POR REGRA: a irmã de N diferente não herda o disparo", () => {
    const emitidos = new Set([chaveDeDisparoTemporal("r1", "l1", dias(7))]);
    const candidatos = [{ leadId: "l1", ancora: dias(7) }];
    expect(naoDisparadosTemporais(candidatos, emitidos, "r2")).toEqual(candidatos);
  });

  it("o mesmo negócio em silêncio continua elegível para OUTRA regra", () => {
    const emitidos = new Set([chaveDeDisparoTemporal("r1", "l1", dias(7))]);
    const candidatos = [
      { leadId: "l1", ancora: dias(7) },
      { leadId: "l2", ancora: dias(9) },
    ];
    expect(naoDisparadosTemporais(candidatos, emitidos, "r1").map((c) => c.leadId)).toEqual(["l2"]);
  });
});
