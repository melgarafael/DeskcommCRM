/**
 * O CONTADOR EM MEMÓRIA NÃO PODE CRESCER PARA SEMPRE.
 *
 * ## Por que este arquivo existe
 *
 * O caminho em memória não era "o plano B improvável": em 2026-08-10, num único job
 * de e2e, ele foi usado **120 vezes** (`redis incr failed` com `fetch failed`).
 *
 * A primeira versão deste cabeçalho justificava a severidade dizendo que as duas
 * variáveis do Upstash são "opcionais no kit self-host". Isso é FALSO, e uma auditoria
 * pegou: `lib/env.ts:83-84` as declara `required()` — o app não sobe sem elas — e o
 * `.env.selfhost.example` as entrega apontando para o contêiner `srh`. O caminho em
 * memória é alcançado por Redis INALCANÇÁVEL (contêiner parado, rede caída, URL
 * errada), não por configuração ausente. A consequência para este teste é a mesma; o
 * que muda é não vender uma razão que o `env.ts` desmente.
 *
 * A chave embute a janela (`<bucket>:<windowStart>`), então cada janela nova cria uma
 * chave nova. O `Map` só sobrescrevia a entrada quando a MESMA chave voltava — e ela
 * nunca volta, porque `windowStart` avança. Nada apagava as antigas: um processo de
 * longa duração acumulava uma entrada por bucket por janela, para sempre.
 *
 * Ordem de grandeza, com os buckets que o app usa hoje: `webhook_in:<token>` tem
 * janela de 60s, o que dá 1.440 chaves por dia por token; `auth:login:ip:<hash>` tem
 * janela de 300s, uma chave por IP por janela em que alguém tentou entrar. Nenhuma
 * delas volta a ser consultada depois de expirar.
 *
 * O que se guarda aqui é o INVARIANTE, não o número: o tamanho do mapa acompanha as
 * janelas VIVAS, não o histórico.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("contador em memória", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("não acumula uma chave por janela vencida", async () => {
    const { checkRateLimit, __chavesEmMemoriaParaTeste } = await import("./rate-limit");
    const JANELA = 60;

    // 400 janelas consecutivas, uma chamada em cada. Antes do conserto isto deixava
    // 400 entradas no mapa; nenhuma delas volta a ser consultada.
    for (let i = 0; i < 400; i++) {
      await checkRateLimit("bucket:sonda", 10, JANELA);
      vi.advanceTimersByTime(JANELA * 1000);
    }

    // O teto é generoso de propósito: o que se cobra é ORDEM DE GRANDEZA, não um
    // número exato — a varredura pode ser oportunista e deixar resto entre passagens.
    // 400 reprova; algumas dezenas passam.
    expect(__chavesEmMemoriaParaTeste()).toBeLessThan(60);
  });

  it("mas NÃO apaga a janela viva — senão o teto deixa de barrar", async () => {
    // Guarda de vacuidade: um `_memBuckets.clear()` a cada chamada passaria no caso
    // de cima e desligaria o limitador inteiro, que é bem pior que o vazamento.
    const { checkRateLimit, __chavesEmMemoriaParaTeste } = await import("./rate-limit");

    const veredito: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      veredito.push((await checkRateLimit("bucket:vivo", 3, 300)).allowed);
    }

    expect(veredito).toEqual([true, true, true, false]);
    expect(__chavesEmMemoriaParaTeste()).toBeGreaterThan(0);
  });

  it("a varredura não zera o balde VIVO sob rajada — e a rajada é quando ela dispara", async () => {
    // Os casos curtos acima não valem como guarda da varredura: ela é oportunista
    // (dispara a cada N chamadas), então quatro chamadas nunca a acionam e um
    // `clear()` no lugar do filtro passaria em todos eles. Aqui a rajada atravessa o
    // gatilho várias vezes DENTRO da mesma janela, que é o caso real — pico de
    // tráfego é exatamente quando a varredura roda.
    const { checkRateLimit } = await import("./rate-limit");

    const barrados: boolean[] = [];
    for (let i = 0; i < 300; i++) {
      barrados.push(!(await checkRateLimit("bucket:rajada", 3, 300)).allowed);
    }

    expect(barrados.slice(0, 3)).toEqual([false, false, false]);
    expect(
      barrados.slice(3).every(Boolean),
      "alguma tentativa passou depois do teto: a varredura apagou o balde da janela viva",
    ).toBe(true);
  });

  it("chaves de buckets diferentes na MESMA janela convivem", async () => {
    // A varredura não pode confundir "chave de outro bucket" com "chave vencida":
    // apagar por prefixo, ou apagar tudo menos a última, zeraria o teto de quem
    // divide a janela — o login e o webhook contam ao mesmo tempo em produção.
    const { checkRateLimit, __chavesEmMemoriaParaTeste } = await import("./rate-limit");

    await checkRateLimit("auth:login:ip:aaa", 5, 300);
    await checkRateLimit("auth:login:ip:bbb", 5, 300);
    await checkRateLimit("webhook_in:token", 5, 60);

    expect(__chavesEmMemoriaParaTeste()).toBe(3);
  });

  it("a janela virada zera a contagem — o contador é de janela FIXA", async () => {
    const { checkRateLimit } = await import("./rate-limit");

    expect((await checkRateLimit("bucket:vira", 1, 60)).count).toBe(1);
    expect((await checkRateLimit("bucket:vira", 1, 60)).allowed).toBe(false);

    vi.advanceTimersByTime(60_000);
    const depois = await checkRateLimit("bucket:vira", 1, 60);
    expect(depois.count).toBe(1);
    expect(depois.allowed).toBe(true);
  });
});
