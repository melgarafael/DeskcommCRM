/**
 * A fila ACORDA quando chega trabalho (#3688) — a prova que o revisor pediu.
 *
 * O defeito, medido pelo @melgarafael com relógio falso e `dormir` de verdade:
 * com o recuo exponencial da fila vazia (#3688), a instalação parada dorme até o
 * teto de 60 s. Um inbound que chega NO MEIO dessa soneca vira job no mesmo
 * worker (o `runDrainLoop` o enfileira), mas o laço da fila só o via quando a
 * soneca terminava. Atraso do claim DEPOIS do vencimento do debounce:
 *
 *   chegada 125 s depois da fila esvaziar ....... 49,25 s
 *   chegada 330 s depois da fila esvaziar ....... 24,25 s
 *
 * Este arquivo reproduz ESSES DOIS NÚMEROS no controle (`sem wake`) e mostra
 * zero nos dois com o wake ligado — a mesma conta, o mesmo recuo, a mesma
 * chegada; a única diferença é o `acordar()` que o drain dispara ao enfileirar.
 *
 * POR QUE UM RELÓGIO VIRTUAL, e não `vi.useFakeTimers()`: os fake timers do
 * vitest não fakeiam o `setTimeout` de `node:timers/promises`, que é quem dorme
 * no worker (medido neste repo, e é o motivo de o laço receber a soneca injetada
 * em vez de chamar `sleep` direto). Aqui o tempo é uma fila de timers que o
 * teste move à mão: cada soneca registra quando COMEÇOU e quanto PEDIU, então
 * "a soneca foi cortada" é uma afirmação sobre números, não sobre espera real.
 */
import { describe, expect, it } from "vitest";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { rodarLoopDaFila } from "@/lib/agent-engine/queue/loop";
import { criarSonecaDaFila, type SonecaDaFila } from "@/lib/agent-engine/queue/soneca";

const INTERVALOS = { ociosoMs: 2_000, retryMs: 250, ociosoMaxMs: 60_000 };
/** `INBOUND_DEBOUNCE_MS` default: o job nasce 8 s depois do evento. */
const DEBOUNCE_MS = 8_000;

function logSpy(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}

interface SonecaRegistrada {
  pedida: number;
  inicio: number;
}

/**
 * O mundo de mentira: relógio virtual, uma fila de jobs com `run_after` em
 * instantes virtuais, e a soneca DE VERDADE (`criarSonecaDaFila`) por cima de um
 * `dormirCru` que agenda no relógio virtual em vez de esperar.
 *
 * A semântica do `relogio` é a da consulta real (`faltaParaOProximoJob`):
 * milissegundos até o próximo job claimável, ou `null` com a fila vazia.
 */
function montarMundo() {
  const estado = {
    agora: 0,
    /** `run_after` (instante virtual) de cada job pendente. */
    pendentes: [] as number[],
    /** Instante virtual de cada claim que trouxe trabalho. */
    claims: [] as number[],
    /** Cada soneca que o laço pediu: quanto pediu e quando começou. */
    sonecas: [] as SonecaRegistrada[],
    parado: false,
  };
  const timers: { em: number; resolver: () => void }[] = [];

  // Deixa as microtarefas do laço terminarem antes de mexer no tempo: sem isto o
  // teste avançaria o relógio por cima de um `await` que ainda não voltou.
  const drenar = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  const soneca = criarSonecaDaFila({
    dormirCru: (ms) =>
      new Promise<void>((resolve) => {
        estado.sonecas.push({ pedida: ms, inicio: estado.agora });
        timers.push({ em: estado.agora + ms, resolver: resolve });
      }),
  });

  const proximo = (): number | null =>
    estado.pendentes.length === 0 ? null : Math.min(...estado.pendentes);

  return {
    estado,
    soneca,
    /** Enfileira um job com `run_after` daqui a `dentroDeMs`, como o drain faz. */
    enfileirar(dentroDeMs: number, acordando = true): void {
      estado.pendentes.push(estado.agora + dentroDeMs);
      if (acordando) soneca.acordar();
    },
    /** Roda o laço até `alvoMs` de tempo virtual, um timer por vez. */
    async avancar(ms: number): Promise<void> {
      const alvo = estado.agora + ms;
      for (let voltas = 0; voltas < 100_000; voltas += 1) {
        await drenar();
        const vencido = timers.filter((t) => t.em <= alvo).sort((a, b) => a.em - b.em)[0];
        if (vencido === undefined) break;
        timers.splice(timers.indexOf(vencido), 1);
        estado.agora = vencido.em;
        vencido.resolver();
      }
      estado.agora = alvo;
      await drenar();
    },
    async rodar(): Promise<void> {
      await rodarLoopDaFila<{ id: string }>({
        relogio: async () => {
          const em = proximo();
          return em === null ? null : em - estado.agora;
        },
        claimar: async () => {
          const em = proximo();
          if (em === null || em > estado.agora) return [];
          estado.pendentes = estado.pendentes.filter((p) => p !== em);
          estado.claims.push(estado.agora);
          return [{ id: `job-${estado.claims.length}` }];
        },
        aoClaimar: () => undefined,
        soneca,
        deveParar: () => estado.parado,
        intervalos: INTERVALOS,
        log: logSpy(),
      });
    },
  };
}

/**
 * O roteiro do mantenedor, numa função: fila esvazia em t=0, o laço recua até o
 * teto de 60 s, o inbound chega `chegada` ms depois e vence `DEBOUNCE_MS` depois
 * disso. Devolve o atraso do claim DEPOIS do vencimento.
 */
async function roteiro(chegada: number, comWake: boolean): Promise<number> {
  const mundo = montarMundo();
  const laco = mundo.rodar();
  // Teto: o laço está dormindo uma soneca de 60 s quando o inbound chega.
  await mundo.avancar(chegada);
  mundo.enfileirar(DEBOUNCE_MS, comWake);
  // Sem wake o claim só sai no fim da soneca em curso; com wake, no vencimento.
  await mundo.avancar(61_000);
  mundo.estado.parado = true;
  await mundo.avancar(61_000);
  await laco;

  const vencimento = chegada + DEBOUNCE_MS;
  const claim = mundo.estado.claims[0];
  expect(claim, "o job nunca foi claimado").toBeDefined();
  return claim! - vencimento;
}

describe("a fila acorda quando chega trabalho (#3688)", () => {
  it("controle SEM wake: reproduz a tabela do mantenedor (49,25 s e 24,25 s)", async () => {
    // Este é o teste que dá sentido ao de baixo: se ele deixar de reproduzir a
    // tabela, o harness deixou de modelar o defeito e o verde do wake não prova
    // nada. O recuo sozinho já produz os dois números — chegada 125 s cai no
    // meio de uma soneca que acaba aos 182,25 s (49,25 s de atraso); aos 330 s,
    // a soneca acaba aos 362,25 s (24,25 s).
    expect(await roteiro(125_000, false)).toBe(49_250);
    expect(await roteiro(330_000, false)).toBe(24_250);
  });

  it.each([125_000, 330_000])(
    "COM wake, chegada aos %i ms: claim NO VENCIMENTO, atraso zero",
    async (chegada) => {
      // O alvo do pedido: "próximo de zero". O que sobra do atraso é o debounce
      // do inbound, que é comportamento desejado e não soneca.
      expect(await roteiro(chegada, true)).toBe(0);
    },
  );

  it("o wake CORTA a soneca de 60 s — a seguinte começa na chegada, não no fim dela", async () => {
    const mundo = montarMundo();
    const laco = mundo.rodar();
    await mundo.avancar(125_000);

    // A soneca em curso pediu o teto. Ela acaba aos 182,25 s sem o wake.
    const emCurso = mundo.estado.sonecas.at(-1);
    expect(emCurso, "o laço não estava dormindo na chegada").toEqual({ pedida: 60_000, inicio: 122_250 });

    mundo.enfileirar(DEBOUNCE_MS);
    await mundo.avancar(20_000);

    // A soneca SEGUINTE nasce no instante da chegada (125 s) e pede o piso: o
    // laço voltou a perguntar ao relógio em vez de esperar os 60 s.
    const depois = mundo.estado.sonecas.at(-1);
    expect(depois?.inicio, "a soneca seguinte só começou depois da de 60 s terminar").toBeLessThan(182_250);
    expect(mundo.estado.claims).toEqual([133_000]);

    mundo.estado.parado = true;
    await mundo.avancar(61_000);
    await laco;
  });

  it("wake sem ninguém dormindo é CONSUMIDO — a soneca seguinte dorme inteira", async () => {
    // O ponto que o revisor cobra: guardar o wake "pendente" faria a próxima
    // soneca nascer cortada, e o laço voltaria ao ritmo curto de antes da #3688
    // (a economia de egress evaporaria). Aqui: dois wakes com o laço acordado e
    // a soneca seguinte continua pedindo o teto e cumprindo-o.
    const pedidas: number[] = [];
    const concluir: (() => void)[] = [];
    const soneca = criarSonecaDaFila({
      dormirCru: (ms) =>
        new Promise<void>((resolve) => {
          pedidas.push(ms);
          concluir.push(resolve);
        }),
    });

    soneca.acordar();
    soneca.acordar();

    let terminou = false;
    const dormida = soneca.dormir(60_000).then(() => {
      terminou = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pedidas, "o wake pendente cortou a soneca no nascimento").toEqual([60_000]);
    expect(terminou, "a soneca saiu antes de completar o tempo pedido").toBe(false);

    concluir[0]!();
    await dormida;
  });

  it("dois wake seguidos cortam UMA soneca, e não acumulam para a próxima", async () => {
    const pedidas: number[] = [];
    const concluir: (() => void)[] = [];
    const soneca = criarSonecaDaFila({
      dormirCru: (ms) =>
        new Promise<void>((resolve) => {
          pedidas.push(ms);
          concluir.push(resolve);
        }),
    });

    const primeira = soneca.dormir(60_000);
    soneca.acordar();
    soneca.acordar();
    await primeira;

    // A segunda soneca não herda nada da rajada de wakes.
    let terminou = false;
    const segunda = soneca.dormir(60_000).then(() => {
      terminou = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminou, "o segundo wake ficou pendente e cortou a soneca seguinte").toBe(false);

    concluir[1]!();
    await segunda;
    expect(pedidas).toEqual([60_000, 60_000]);
  });

  it("wake que chega DURANTE o claim não deixa a volta dormir", async () => {
    // A janela que sobraria: o drain enfileira enquanto o laço consulta ou
    // claima, quando não há soneca para cortar. Sem a conferência de geração, a
    // volta dormiria (aqui, o retry de 250 ms do boot virando o piso de 2 s) com
    // o job já enfileirado — o mesmo defeito com probabilidade menor.
    const pedidas: number[] = [];
    const relogio = async (): Promise<number | null> => 8_000;
    let claims = 0;
    let geracao = 0;
    const soneca: SonecaDaFila = {
      acordar: () => void (geracao += 1),
      geracao: () => geracao,
      dormir: async (ms) => void pedidas.push(ms),
    };
    let rodadas = 0;

    await rodarLoopDaFila<{ id: string }>({
      relogio,
      claimar: async () => {
        claims += 1;
        // O job nasce DURANTE a primeira rodada, depois do claim.
        if (claims === 1) soneca.acordar();
        return [];
      },
      aoClaimar: () => void (rodadas += 1),
      soneca,
      deveParar: () => rodadas >= 2,
      intervalos: INTERVALOS,
      log: logSpy(),
    });

    // O discriminador é `pedidas`. Sem a conferência, a rodada que viu o wake
    // ainda dormiria os 250 ms calculados antes dele (o retry do boot) e só
    // depois consultaria o relógio: [250, 2_000], com o job esperando esses
    // 250 ms. Com ela, a rodada não dorme e a seguinte já pede a espera do job
    // recém-enfileirado.
    expect(pedidas).toEqual([2_000]);
    // A segunda rodada consultou o relógio (os 8 s do debounce) e por isso não
    // claima: trabalho agendado à frente não se pega agora.
    expect(claims).toBe(1);
  });
});

describe("o desligamento continua imediato (#2823)", () => {
  it("abort corta a soneca em curso, sem esperar o teto", async () => {
    const controle = new AbortController();
    const soneca = criarSonecaDaFila({ signal: controle.signal });
    const comeco = Date.now();
    const dormida = soneca.dormir(60_000);
    setTimeout(() => controle.abort(), 20);

    await expect(dormida).rejects.toThrow();
    // 60 s de soneca, ~20 ms de espera: o abort atravessa o `race` em vez de ser
    // engolido por ele.
    expect(Date.now() - comeco).toBeLessThan(1_000);
  });

  it("o LAÇO inteiro sai no abort em milissegundos, não no fim da soneca", async () => {
    const controle = new AbortController();
    const soneca = criarSonecaDaFila({ signal: controle.signal });
    let parado = false;
    controle.signal.addEventListener("abort", () => {
      parado = true;
    });

    const comeco = Date.now();
    const laco = rodarLoopDaFila<{ id: string }>({
      relogio: async () => null,
      claimar: async () => [],
      aoClaimar: () => undefined,
      soneca,
      deveParar: () => parado,
      intervalos: INTERVALOS,
      log: logSpy(),
    });
    setTimeout(() => controle.abort(), 20);

    // Resolve, não rejeita: o worker faz `await workerLoop` antes de drenar os
    // jobs em voo, e uma rejeição aqui mataria o processo com lease aberto.
    await expect(laco).resolves.toBeUndefined();
    expect(Date.now() - comeco).toBeLessThan(1_000);
  });

  it("wake antes do abort não deixa rejeição órfã (o perdedor da corrida)", async () => {
    // Soneca cortada pelo wake e abortada logo depois é o caminho NORMAL do
    // shutdown. Sem o `catch` na promessa da dormida, o `sleep` rejeitaria
    // sozinho e o Node 22 derrubaria o processo por `unhandledRejection` — que
    // o vitest também acusaria.
    const controle = new AbortController();
    const soneca = criarSonecaDaFila({ signal: controle.signal });
    const dormida = soneca.dormir(60_000);
    soneca.acordar();
    await expect(dormida).resolves.toBeUndefined();
    controle.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // E a soneca seguinte, já com o sinal abortado, rejeita na hora.
    await expect(soneca.dormir(60_000)).rejects.toThrow();
  });
});
