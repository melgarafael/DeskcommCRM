/**
 * O INSTRUMENTO DA PÁGINA — o que a issue #1374 chama de "instrumento que falta".
 *
 * Nenhuma spec de e2e escuta o console do navegador, e o `playwright.config.ts`
 * também não. Por isso o `grep` por `hydrat` nos logs de um run vermelho
 * devolve zero — e esse zero é GATE AUSENTE, não ausência: quando a caixa de
 * streaming SSR (`<div hidden id="S:N">`) fica órfã, ninguém registrou o
 * `pageerror` ou o `console` que o navegador emitiria junto (issue #1374,
 * "Instrumento que falta").
 *
 * O contrato deste módulo, em três linhas:
 *
 *  1. ALOCA um conjunto de ouvintes por chamada — um `pageerror` e um `console`,
 *     nunca mais que isso, com teto de mensagens guardadas (instrumento não é
 *     log infinito);
 *  2. LIBERA em `encerrar()` — a spec envolve o uso em `try/finally`, então o
 *     instrumento não vixa ouvinte entre testes ("teste sem vazamento", provado
 *     por `tests/unit/instrumento-de-pagina-nao-vaza.test.ts`);
 *  3. COLETA e devolve — quem decide se o erro vira asserção é a spec. Aqui
 *     afirmar `pageerror` vazio sem histórico medido seria inventar régua; a
 *     evidência fica pronta para o anexo do teste.
 */
import type { Page } from "@playwright/test";

/** Teto de mensagens por lista: instrumento que cresce sem limite vira o próprio vazamento. */
const TETO_DE_MENSAGENS = 50;

export interface InstrumentoDaPagina {
  /** Erros não tratados da página (`pageerror`) — o sinal de hidratação quebrada. */
  readonly erros: string[];
  /** Mensagens de console, no formato `tipo: texto`. */
  readonly console: string[];
  /** Libera os DOIS ouvintes. Idempotente: chamar duas vezes não estoura. */
  encerrar(): void;
}

/**
 * Liga o instrumento na página e devolve o handle com `encerrar()`.
 *
 * Uso canônico (e o motivo do `finally`):
 *
 * ```ts
 * const instrumento = instalarInstrumento(page);
 * try {
 *   // ... navegação e medição ...
 * } finally {
 *   instrumento.encerrar();
 * }
 * ```
 */
export function instalarInstrumento(pagina: Page): InstrumentoDaPagina {
  const erros: string[] = [];
  const console: string[] = [];
  const guardar = (lista: string[], texto: string): void => {
    if (lista.length < TETO_DE_MENSAGENS) lista.push(texto);
  };

  const aoErro = (erro: unknown): void => {
    guardar(erros, erro instanceof Error ? erro.message : String(erro));
  };
  const aoConsole = (mensagem: unknown): void => {
    // `ConsoleMessage` tem `type()`/`text()`; o duck-typing é o que deixa o
    // dublê falso do teste de vazamento sem depender do Playwright de verdade.
    const m = mensagem as { type?: () => string; text?: () => string };
    const tipo = typeof m.type === "function" ? m.type() : "?";
    const texto = typeof m.text === "function" ? m.text() : String(mensagem);
    guardar(console, `${tipo}: ${texto}`);
  };

  pagina.on("pageerror", aoErro);
  pagina.on("console", aoConsole);

  let aberto = true;
  return {
    erros,
    console,
    encerrar(): void {
      if (!aberto) return;
      aberto = false;
      if (typeof pagina.removeListener === "function") {
        pagina.removeListener("pageerror", aoErro);
        pagina.removeListener("console", aoConsole);
      }
    },
  };
}
