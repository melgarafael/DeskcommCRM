import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sendInBubbles } from "@/lib/agent-engine/agent/split-message";

/**
 * A PERGUNTA QUE DECIDE ESTE RECURSO: o atraso humano SOMA ao anti-ban, ou SUBSTITUI?
 *
 * O trabalho original é de @w4rlockem (PR #644): antes da 1ª bolha do turno, o
 * agente acende "digitando…" e espera um tempo proporcional ao texto, porque
 * responder no instante em que o modelo termina é inconfundivelmente robótico.
 *
 * O recurso encosta em território sensível. A doutrina desta casa (CLAUDE.md,
 * "Anti-banimento") exige throttle de 1 msg/1.2s + jitter ≤800ms ENTRE mensagens
 * físicas — e bolha é mensagem física. Há dois desfechos ruins simétricos:
 *
 *   • o atraso SUBSTITUI o jitter  → o número passa a enviar bolhas mais juntas
 *                                     do que o anti-ban permite. Enfraquece a
 *                                     proteção que evita banimento.
 *   • o atraso é cobrado POR BOLHA → o cliente espera duas vezes na mesma pausa.
 *
 * O código de hoje escolhe certo — `i === 0` paga o atraso humano, `else` paga o
 * jitter, mutuamente exclusivos por índice —, e é isso que estes testes prendem.
 *
 * ─── Por que este arquivo existe, se o PR já trouxe testes ──────────────────
 *
 * Os testes do PR são bons e cobrem a fórmula, a ordem (sinalizar antes de
 * esperar) e a falha macia da presença. O que eles NÃO cobrem é justamente esta
 * interação: `tests/unit/agent-split-send.test.ts` prova o jitter num caso SEM
 * `antesDaPrimeira` (linha ~21) e exercita `antesDaPrimeira` com `jitter: () => 0`
 * (linha ~43). Entre os dois sobra o buraco: uma regressão que pagasse o jitter
 * apenas quando o atraso humano está DESLIGADO — `else if (!opts.antesDaPrimeira)`
 * — deixaria a suíte inteira verde e afrouxaria o anti-ban em produção, onde o
 * atraso está sempre ligado. Perda silenciosa: nenhum grep de símbolo a acha,
 * porque os dois símbolos continuam lá.
 */

describe("o atraso humano NÃO substitui o throttle anti-ban entre bolhas", () => {
  it("com o atraso ligado, toda pausa entre bolhas continua sendo paga", async () => {
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    // `antesDaPrimeira` presente = o recurso LIGADO, que é o estado de produção.
    const antesDaPrimeira = vi.fn(async () => undefined);
    const texto = "Bolha um aqui.\n\nBolha dois aqui.\n\nBolha três aqui.";

    await sendInBubbles(texto, {
      enabled: true,
      maxChars: 20,
      send,
      sleep,
      jitter: () => 1500,
      antesDaPrimeira,
    });

    const bolhas = send.mock.calls.length;
    expect(bolhas).toBeGreaterThanOrEqual(3);

    // N bolhas ⇒ N−1 pausas anti-ban, nem uma a menos. A igualdade estrita (e não
    // um `toHaveBeenCalledWith`) é o ponto: ela reprova tanto a pausa que sumiu
    // quanto a que virou curta demais.
    expect(sleep.mock.calls).toEqual(Array.from({ length: bolhas - 1 }, () => [1500]));

    // E o atraso humano não roubou uma das pausas: ele é do TURNO, uma vez só.
    expect(antesDaPrimeira).toHaveBeenCalledTimes(1);
  });

  it("o atraso humano não usa o `sleep` do jitter — as duas esperas têm donos diferentes", async () => {
    // `esperarComoHumano` recebe o próprio `sleep` no chamador real. Se um dia
    // alguém "simplificar" fazendo `antesDaPrimeira` dormir pelo `opts.sleep` do
    // jitter, a contagem acima passaria a medir duas coisas somadas e deixaria de
    // valer como guarda do anti-ban.
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));

    await sendInBubbles("uma bolha só", {
      enabled: false,
      maxChars: 600,
      send,
      sleep,
      jitter: () => 1500,
      antesDaPrimeira: async () => undefined,
    });

    expect(send).toHaveBeenCalledTimes(1);
    // Uma bolha ⇒ zero pausa de jitter, mesmo com o atraso humano ligado.
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sem o atraso ligado, o jitter é exatamente o de antes — nenhum chamador regride", async () => {
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const texto = "Bolha um aqui.\n\nBolha dois aqui.\n\nBolha três aqui.";

    await sendInBubbles(texto, { enabled: true, maxChars: 20, send, sleep, jitter: () => 1500 });

    const bolhas = send.mock.calls.length;
    expect(sleep.mock.calls).toEqual(Array.from({ length: bolhas - 1 }, () => [1500]));
  });
});

/**
 * FIAÇÃO — mesmo padrão de `handoff-fernando-fiacao.test.ts`.
 *
 * `jaEsperouComoHumano` mora num closure no meio de um arquivo de ~2700 linhas e
 * não é alcançável por teste de função pura: o turno inteiro precisaria de pool,
 * modelo e canal. Mas a perda dele é silenciosa e cara — a cadeia `before_send`
 * re-roda quando um fail-safe veta (promessa, vocabulário interno e, desde o
 * #634, o falso-vazio), e sem o flag CADA passagem cobraria uma espera nova do
 * mesmo cliente: um turno com dois vetos ficaria mudo por mais de 20 segundos.
 *
 * O conserto do "responde rápido demais" viraria o defeito simétrico, pior que o
 * original. Guardar a fiação na fonte é a rede mais barata que alcança isso.
 *
 * Desde a #654 a pausa é paga em `esperaForaDoLock` — fora da posse do lock do
 * número — e a guarda do flag migrou junto para lá.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);

describe("fiação — a espera humana é paga UMA vez por turno", () => {
  it("`esperaForaDoLock` abre com a guarda do flag e a arma antes de esperar", () => {
    const i = FONTE_INBOUND.indexOf("esperaForaDoLock: async (): Promise<void> => {");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 400);
    // Ordem importa: guardar DEPOIS de esperar não impediria a segunda espera.
    expect(janela).toMatch(/if \(jaEsperouComoHumano\) return;\s*\n\s*jaEsperouComoHumano = true;/);
  });

  it("o flag é do TURNO — declarado no closure do turno, nunca em módulo", () => {
    // Em escopo de módulo ele vazaria entre turnos e entre tenants: o 2º cliente
    // do processo deixaria de receber a pausa.
    expect(FONTE_INBOUND).toMatch(/^ {2}let jaEsperouComoHumano = false;$/m);
  });

  it("o call site mantém o jitter anti-ban entre bolhas, sem a pausa humana dentro do lock", () => {
    const i = FONTE_INBOUND.indexOf("sendInBubbles(finalBody, {");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 1600);
    // Os dois convivem: o jitter é throttle anti-ban entre mensagens físicas, o
    // atraso humano é a pausa do turno. Perder o primeiro é afrouxar o anti-ban.
    expect(janela).toMatch(/jitter:\s*\(\)\s*=>\s*1200 \+ Math\.floor\(Math\.random\(\) \* 800\)/);
    // Issue #654: a pausa humana saiu daqui. Ela era paga no `antesDaPrimeira`, que
    // rodava dentro do callback `send` — isto é, com o `pg_advisory_xact_lock` do
    // NÚMERO na mão. Trazer `esperarComoHumano(` de volta para esta janela reintroduz
    // o defeito: a posse do lock volta a durar a pausa inteira (1.2s–7.5s).
    expect(janela).not.toContain("antesDaPrimeira:");
    expect(janela).not.toContain("esperarComoHumano(");
  });
});
