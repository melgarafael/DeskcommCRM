/**
 * O envio rápido: a rodada manda em rajada, com o espaçamento e o prazo dela,
 * e para no primeiro desfecho que valeria para os envios seguintes.
 *
 * Relógio de mentira: `esperar` avança o tempo em vez de dormir, e cada envio
 * "leva" 300 ms. Assim o teste mede o ritmo de verdade sem levar 38 segundos.
 */
import { describe, expect, it } from "vitest";

import { desfechoParaARajada, rodarEmRajada, type DesfechoDeUm } from "./rajada";

const CONFIG = { concorrencia: 4, intervaloEntreIniciosMs: 167, tamanhoDoLote: 24, prazoMs: 38_000 };

function cenario(opts: {
  pendentes: number;
  desfecho?: (id: number) => DesfechoDeUm;
  emAndamentoAte?: number;
  duracaoDoEnvioMs?: number;
}) {
  let relogio = 0;
  const fila = Array.from({ length: opts.pendentes }, (_, i) => i);
  const enviados: number[] = [];
  const inicios: number[] = [];
  let perguntasDeAndamento = 0;
  let concluiu = 0;
  return {
    enviados,
    inicios,
    get concluiu() {
      return concluiu;
    },
    dep: {
      buscarLote: async (n: number) => fila.splice(0, n),
      enviarUm: async (id: number) => {
        inicios.push(relogio);
        relogio += opts.duracaoDoEnvioMs ?? 300;
        enviados.push(id);
        return opts.desfecho?.(id) ?? { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" };
      },
      aindaEmAndamento: async () => ++perguntasDeAndamento <= (opts.emAndamentoAte ?? Infinity),
      concluirSeAcabou: async () => {
        concluiu++;
        return { enviadas: 0, pulados: 0, concluidas: 1, detalhe: "concluida" };
      },
      agora: () => relogio,
      esperar: async (ms: number) => {
        relogio += ms;
      },
    },
  };
}

describe("rodarEmRajada", () => {
  it("manda a lista inteira numa rodada quando cabe no prazo, e conclui", async () => {
    const c = cenario({ pendentes: 60 });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas).toBe(60);
    expect(r.concluidas).toBe(1);
    expect(c.concluiu).toBe(1);
    expect(new Set(c.enviados).size).toBe(60); // ninguém duas vezes
  });

  it("nunca começa mais de 6 envios por segundo", async () => {
    const c = cenario({ pendentes: 100, duracaoDoEnvioMs: 0 });
    await rodarEmRajada(c.dep, CONFIG);
    for (let i = 1; i < c.inicios.length; i++) {
      expect(c.inicios[i]! - c.inicios[i - 1]!).toBeGreaterThanOrEqual(167);
    }
  });

  it("para de começar envios no prazo — o resto sai na rodada seguinte", async () => {
    // Envio instantâneo: o relógio de mentira soma as durações em série e não
    // mediria a concorrência — aqui quem manda é o espaçamento.
    const c = cenario({ pendentes: 1000, duracaoDoEnvioMs: 0 });
    const r = await rodarEmRajada(c.dep, CONFIG);
    // 38 s a 6 por segundo: 228 inícios, nunca a lista inteira.
    expect(r.enviadas).toBeGreaterThanOrEqual(220);
    expect(r.enviadas).toBeLessThanOrEqual(228);
    expect(c.concluiu).toBe(0);
    expect(r.detalhe).toMatch(/:prazo$/);
  });

  it("a campanha pausou por falha da plataforma: nenhum envio novo depois", async () => {
    const c = cenario({
      pendentes: 50,
      desfecho: (id) =>
        id === 5
          ? { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "pausada:132015" }
          : { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    // Os que já estavam em voo terminam (até 3 além do 5); nenhum começa depois.
    expect(c.enviados.length).toBeLessThanOrEqual(9);
    expect(r.detalhe).toMatch(/pausada:132015$/);
  });

  it("o provedor pediu para desacelerar: a rajada para e o resto espera a próxima rodada", async () => {
    const c = cenario({
      pendentes: 50,
      desfecho: (id) =>
        id === 10
          ? { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "limite:429" }
          : { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(c.enviados.length).toBeLessThan(15);
    expect(r.detalhe).toMatch(/limite:429$/);
  });

  it("pausar pela tela entre um lote e outro para a rajada", async () => {
    const c = cenario({ pendentes: 100, emAndamentoAte: 1 });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas).toBe(24); // só o primeiro lote
    expect(r.detalhe).toMatch(/fora_de_andamento$/);
  });

  it("devolve todos os números por onde falou, cada um uma vez (#3112)", async () => {
    const c = cenario({
      pendentes: 9,
      desfecho: (id) => ({
        enviadas: 1,
        pulados: 0,
        concluidas: 0,
        detalhe: "enviado:sent:rodizio",
        numero: id % 3 === 0 ? "vinculado" : "principal",
      }),
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas).toBe(9);
    expect([...r.numeros].sort()).toEqual(["principal", "vinculado"]);
  });

  it("pulados (bloqueado, exclusão) não param a rajada", async () => {
    const c = cenario({
      pendentes: 30,
      desfecho: (id) =>
        id % 3 === 0
          ? { enviadas: 0, pulados: 1, concluidas: 0, detalhe: "pulado:opt_out" }
          : { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
    });
    const r = await rodarEmRajada(c.dep, CONFIG);
    expect(r.enviadas + r.pulados).toBe(30);
    expect(r.pulados).toBe(10);
  });
});

describe("desfechoParaARajada", () => {
  it("só o que valeria para os envios seguintes para a rajada", () => {
    for (const d of ["pausada:131048", "ritmo:fora_da_janela", "canal:sem_numero_livre", "limite:130429", "erro_na_reserva:x", "org_nao_operante"]) {
      expect(desfechoParaARajada(d)).toBe(true);
    }
    for (const d of ["enviado:sent:principal", "pulado:opt_out", "pulado:suprimido", "falhou", "ja_reservado", "falha:modelo_sem_valores"]) {
      expect(desfechoParaARajada(d)).toBe(false);
    }
  });
});
