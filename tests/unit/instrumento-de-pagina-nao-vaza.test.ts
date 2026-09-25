/**
 * O instrumento da página NÃO VAZA ouvintes — e DISTINGUE o que deve distinguir.
 *
 * `instalarInstrumento` (em `tests/e2e/helpers/instrumento-da-pagina.ts`) é
 * chamado a cada teste que cuida da caixa de streaming SSR (issue #1374). Um
 * instrumento que aloca por chamada e não libera acumula ouvintes no emitter da
 * página — o próprio instrumento vira o vazamento que existe para observar.
 * Este arquivo é a régua desse contrato, em quatro frentes:
 *
 *  1. ALOCAÇÃO: um ouvinte por evento, dois no total — "por chamada" não vira
 *     pilha;
 *  2. COLETA: `pageerror` e `console` chegam com o conteúdo que a spec anexa;
 *  3. LIBERAÇÃO: depois de `encerrar()`, a superfície fica com ZERO ouvintes e
 *     eventos seguintes não contaminam a coleta — o "teste sem vazamento";
 *  4. ROBUSTEZ: `encerrar()` idempotente (o `finally` de duas camadas não
 *     estoura) e superfície sem `removeListener` não derruba o teste.
 *
 * O dublê é a própria superfície mínima (`on`/`removeListener`), emitida à mão:
 * não há navegador no `pnpm test:unit`, e a spec de Playwright é quem prova o
 * instrumento em página de verdade (lá o contrato é o mesmo, medido aqui).
 */
import { describe, expect, it } from "vitest";

import type { Page } from "@playwright/test";

import { instalarInstrumento } from "../e2e/helpers/instrumento-da-pagina";

type Ouvinte = (arg: unknown) => void;

/** A superfície mínima que o instrumento usa de uma `Page`. */
class SuperficieFalsa {
  private readonly ouvintes = new Map<string, Set<Ouvinte>>();

  on(evento: string, ouvinte: Ouvinte): this {
    if (!this.ouvintes.has(evento)) this.ouvintes.set(evento, new Set());
    this.ouvintes.get(evento)!.add(ouvinte);
    return this;
  }

  removeListener(evento: string, ouvinte: Ouvinte): this {
    this.ouvintes.get(evento)?.delete(ouvinte);
    return this;
  }

  emitir(evento: string, argumento: unknown): void {
    for (const ouvinte of [...(this.ouvintes.get(evento) ?? [])]) ouvinte(argumento);
  }

  totalDeOuvintes(): number {
    let total = 0;
    for (const conjunto of this.ouvintes.values()) total += conjunto.size;
    return total;
  }

  comoPagina(): Page {
    return this as unknown as Page;
  }
}

describe("o instrumento da página (issue #1374)", () => {
  it("aloca um ouvinte por evento — dois no total, nunca pilha por chamada", () => {
    const superficie = new SuperficieFalsa();
    instalarInstrumento(superficie.comoPagina());
    expect(superficie.totalDeOuvintes()).toBe(2);

    // Segunda chamada na MESMA superfície dobra (é chamada por teste, com página
    // própria); o que não pode é uma chamada guardar mais que um por evento.
    instalarInstrumento(superficie.comoPagina());
    expect(superficie.totalDeOuvintes()).toBe(4);
  });

  it("coleta pageerror e console com o conteúdo que a spec anexa", () => {
    const superficie = new SuperficieFalsa();
    const instrumento = instalarInstrumento(superficie.comoPagina());

    superficie.emitir("pageerror", new Error("hydration failed"));
    superficie.emitir("console", {
      type: () => "error",
      text: () => "Warning: text content did not match",
    });

    expect(instrumento.erros).toEqual(["hydration failed"]);
    expect(instrumento.console).toEqual(["error: Warning: text content did not match"]);
    instrumento.encerrar();
  });

  it("encerrar() libera OS DOIS ouvintes — sem vazamento entre testes", () => {
    const superficie = new SuperficieFalsa();
    const instrumento = instalarInstrumento(superficie.comoPagina());
    instrumento.encerrar();

    expect(
      superficie.totalDeOuvintes(),
      "ouvinte sobrando depois do encerrar(): o próximo teste herdaria a escuta do anterior",
    ).toBe(0);

    // Evento emitido DEPOIS de encerrar não contamina a coleta do instrumento —
    // a lista congelou no momento da liberação.
    superficie.emitir("pageerror", new Error("tarde demais"));
    expect(instrumento.erros).toEqual([]);
  });

  it("encerrar() é idempotente — o try/finally de duas camadas não estoura", () => {
    const superficie = new SuperficieFalsa();
    const instrumento = instalarInstrumento(superficie.comoPagina());
    expect(() => {
      instrumento.encerrar();
      instrumento.encerrar();
    }).not.toThrow();
    expect(superficie.totalDeOuvintes()).toBe(0);
  });

  it("superfície sem removeListener não derruba o finally", () => {
    const semRemocao = {
      on: () => undefined,
    } as unknown as Page;
    const instrumento = instalarInstrumento(semRemocao);
    expect(() => instrumento.encerrar()).not.toThrow();
  });

  it("o teto de mensagens é real — console furioso não vira log infinito", () => {
    const superficie = new SuperficieFalsa();
    const instrumento = instalarInstrumento(superficie.comoPagina());
    for (let i = 0; i < 120; i += 1) {
      superficie.emitir("console", { type: () => "log", text: () => `msg ${i}` });
    }
    expect(instrumento.console).toHaveLength(50);
    instrumento.encerrar();
  });
});
