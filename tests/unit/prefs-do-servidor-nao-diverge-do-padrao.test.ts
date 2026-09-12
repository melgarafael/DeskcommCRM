/**
 * O SNAPSHOT DO SERVIDOR É UMA CÓPIA À MÃO — ESTE ARQUIVO É O QUE A IMPEDE DE DIVERGIR.
 *
 * `lib/notifications/prefs.ts` guarda `PREFS_DO_SERVIDOR` escrito à mão, e a
 * duplicata é deliberada: derivar o valor chamando `prefsPadrao()` no escopo do
 * módulo leria o `localStorage` de verdade no navegador, que é exatamente o que
 * `getServerSnapshot` existe para não fazer.
 *
 * Mas duplicata sem vigia diverge. Acrescentar uma categoria a
 * `NOTIFY_UI_CATEGORIES` muda `prefsPadrao()` e não muda o objeto congelado — e
 * aí `getServerSnapshot` devolve um objeto SEM aquela chave. O componente lê
 * `prefs[cat][canal]` e estoura, ou (pior) o React vê valores diferentes dos
 * dois lados e o defeito de hidratação do #690 volta calado.
 *
 * A comparação tem de ser feita SEM `window` — é a única condição em que
 * `prefsPadrao()` é determinístico, e é a condição em que o servidor roda.
 */
import { afterEach, describe, expect, it } from "vitest";

import { NOTIFY_UI_CATEGORIES, getPrefsSnapshotDoServidor, prefsPadrao } from "@/lib/notifications/prefs";

const janelaReal = globalThis.window;

afterEach(() => {
  globalThis.window = janelaReal;
});

/** O que `prefsPadrao()` produz num Node sem DOM — o que o servidor de verdade vê. */
function padraoSemJanela() {
  // @ts-expect-error — apagar de propósito, para `typeof window === "undefined"` ser verdade.
  delete globalThis.window;
  try {
    return prefsPadrao();
  } finally {
    globalThis.window = janelaReal;
  }
}

describe("o snapshot do servidor é idêntico ao padrão que o servidor produz", () => {
  it("CONTROLE: sem este caso, os de baixo passariam com a lista vazia", () => {
    expect(NOTIFY_UI_CATEGORIES.length).toBeGreaterThanOrEqual(5);
  });

  it("os dois objetos são iguais em profundidade", () => {
    expect(
      getPrefsSnapshotDoServidor(),
      "`PREFS_DO_SERVIDOR` divergiu de `prefsPadrao()`. Quem mudar um tem de " +
        "mudar o outro — senão o servidor e a primeira renderização do cliente " +
        "voltam a discordar, que é o defeito da issue #690.",
    ).toEqual(padraoSemJanela());
  });

  it("toda categoria declarada existe no snapshot do servidor, nos dois canais", () => {
    const doServidor = getPrefsSnapshotDoServidor();
    for (const categoria of NOTIFY_UI_CATEGORIES) {
      expect(doServidor[categoria], `categoria \`${categoria}\` ausente`).toBeDefined();
      expect(typeof doServidor[categoria].in_app).toBe("boolean");
      expect(typeof doServidor[categoria].push).toBe("boolean");
    }
  });
});
