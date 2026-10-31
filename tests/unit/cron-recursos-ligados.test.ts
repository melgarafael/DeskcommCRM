/**
 * A LEITURA COMPARTILHADA de "o que está ligado" (#3694).
 *
 * O que este arquivo prova, e por que cada caso existe:
 *
 *   - uma ida ao banco por JANELA, não por rota: oito crons de minuto liam oito
 *     consultas vazias; agora todos leem a mesma resposta;
 *   - as rotas que batem JUNTAS (o agendador dispara várias no mesmo segundo)
 *     compartilham a MESMA chamada em voo — sem isso o cache não seria
 *     compartilhado, seria só cacheado, e a conta voltaria a ser N;
 *   - falha de qualquer tipo responde LIGADO (fail-open): a rota roda como
 *     antes. O gate nunca pode ser o motivo de um recurso parar em silêncio;
 *   - a invalidação no evento (o botão "Iniciar" da campanha) é vista na
 *     chamada seguinte, inclusive quando uma leitura já estava em voo.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  esquecerLeituraDosRecursos,
  invalidarRecursosLigados,
  MOTIVO_DO_PULO,
  RECURSOS_DO_CRON,
  recursoLigado,
  VALIDADE_MS,
  type RecursoDoCron,
} from "@/lib/cron/recursos-ligados";

const TODOS = Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, true])) as Record<RecursoDoCron, boolean>;

/** Cliente mínimo: conta as RPCs e responde o que o caso mandar. */
function cliente(resposta: () => Promise<{ data: unknown; error: unknown }>) {
  const chamadas: string[] = [];
  return {
    chamadas,
    db: {
      rpc: (fn: string) => {
        chamadas.push(fn);
        return resposta();
      },
    } as never,
  };
}

const ok = (valores: unknown) => () => Promise.resolve({ data: valores, error: null });

beforeEach(() => {
  esquecerLeituraDosRecursos();
});

describe("leitura compartilhada dos recursos ligados", () => {
  it("duas rotas na MESMA janela fazem UMA chamada ao banco — e recebem a mesma resposta", async () => {
    const { db, chamadas } = cliente(ok({ ...TODOS, campanhas: false }));

    const primeira = await recursoLigado(db, "campanhas", 1_000);
    const segunda = await recursoLigado(db, "propostas", 1_000 + VALIDADE_MS - 1);

    expect(primeira).toBe(false);
    expect(segunda).toBe(true);
    expect(chamadas).toEqual(["fn_cron_recursos_ligados"]);
  });

  it("rotas que chegam JUNTAS compartilham a chamada em voo (não N chamadas)", async () => {
    // A promessa só resolve no próximo tick do microtask: as três chegam antes.
    const { db, chamadas } = cliente(ok({ ...TODOS }));

    await Promise.all([
      recursoLigado(db, "followup", 5_000),
      recursoLigado(db, "followup_silencio", 5_000),
      recursoLigado(db, "fila_followup", 5_000),
    ]);

    expect(chamadas).toEqual(["fn_cron_recursos_ligados"]);
  });

  it("vencida a janela, a próxima batida relê — é assim que o recurso liga sozinho", async () => {
    const { db, chamadas } = cliente(ok({ ...TODOS, followup: false }));

    expect(await recursoLigado(db, "followup", 0)).toBe(false);
    expect(await recursoLigado(db, "followup", VALIDADE_MS + 1)).toBe(false);
    expect(chamadas).toHaveLength(2);
  });

  it("a janela é curta de propósito: entre 30 e 60 s (o teto que a issue pede)", () => {
    expect(VALIDADE_MS).toBeGreaterThanOrEqual(30_000);
    expect(VALIDADE_MS).toBeLessThanOrEqual(60_000);
  });

  it("só `false` explícito desliga — chave ausente, nula ou de outro tipo vale LIGADO", async () => {
    const { db } = cliente(ok({ campanhas: false, propostas: null, seguradora: 0, followup: "sim" }));

    expect(await recursoLigado(db, "campanhas", 0)).toBe(false);
    expect(await recursoLigado(db, "propostas", 0)).toBe(true);
    expect(await recursoLigado(db, "followup", 0)).toBe(true);
    // Chave que o banco não devolveu: ligado (lado seguro do erro).
    expect(await recursoLigado(db, "historico", 0)).toBe(true);
  });

  it("RPC com erro: TUDO ligado — a rota roda como antes, e o memo evita martelar o banco", async () => {
    const { db, chamadas } = cliente(() =>
      Promise.resolve({ data: null, error: { code: "PGRST202", message: "function not found" } }),
    );

    const valores = await Promise.all(RECURSOS_DO_CRON.map((r) => recursoLigado(db, r, 0)));
    expect(valores.every(Boolean)).toBe(true);

    // Segunda batida dentro da janela: sem nova chamada (falha também é cacheada).
    expect(await recursoLigado(db, "campanhas", 1)).toBe(true);
    expect(chamadas).toHaveLength(1);
  });

  it("RPC que LANÇA (rede, fetch abortado): tudo ligado, nunca desligado", async () => {
    const { db } = cliente(() => Promise.reject(new Error("fetch failed")));

    expect(await recursoLigado(db, "webhook_replay", 0)).toBe(true);
  });

  it("corpo fora do contrato (array, string, null): tudo ligado", async () => {
    for (const corpo of [[], "texto", null, 42]) {
      esquecerLeituraDosRecursos();
      const { db } = cliente(ok(corpo));
      expect(await recursoLigado(db, "campanhas", 0)).toBe(true);
    }
  });

  it("invalidar no evento: a chamada seguinte relê, sem esperar a janela", async () => {
    const { db, chamadas } = cliente(ok({ ...TODOS, campanhas: false }));
    expect(await recursoLigado(db, "campanhas", 0)).toBe(false);

    invalidarRecursosLigados(); // o botão "Iniciar" da campanha

    expect(await recursoLigado(db, "campanhas", 1)).toBe(false);
    expect(chamadas).toHaveLength(2);
  });

  it("invalidação durante uma leitura EM VOO não regrava o memo com o retrato antigo", async () => {
    let liberar: (v: unknown) => void = () => undefined;
    const lenta = () =>
      new Promise<{ data: unknown; error: unknown }>((resolve) => {
        liberar = (v) => resolve({ data: v, error: null });
      });
    const { db, chamadas } = cliente(lenta);

    const emVoo = recursoLigado(db, "campanhas", 0);
    invalidarRecursosLigados(); // a campanha nasceu no meio da leitura
    liberar({ ...TODOS, campanhas: false }); // retrato de ANTES do evento
    await emVoo;

    // A chamada seguinte não pode ter sido servida por aquele retrato.
    const proxima = recursoLigado(db, "campanhas", 1);
    liberar({ ...TODOS, campanhas: false });
    expect(await proxima).toBe(false);
    expect(chamadas).toHaveLength(2);
  });

  it("`MOTIVO_DO_PULO` diz na resposta o que aconteceu — 'pulado' não é 'vazio'", () => {
    expect(MOTIVO_DO_PULO).toBe("recurso_desligado");
  });
});
