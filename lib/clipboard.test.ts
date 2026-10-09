import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "./clipboard";

/** Família dos "erros inesperados" em http://IP: navigator.clipboard é undefined fora de secure context. */
describe("copyToClipboard — dentro E fora de secure context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("com navigator.clipboard disponível → delega e devolve true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyToClipboard("abc")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("SEM navigator.clipboard (contexto não-seguro) → fallback execCommand e devolve true", async () => {
    vi.stubGlobal("navigator", {}); // clipboard ausente — exatamente o browser em http://IP
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    await expect(copyToClipboard("xyz")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("clipboard nega (permissão) E execCommand falha → devolve false, sem lançar", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    document.execCommand = vi.fn().mockReturnValue(false);
    await expect(copyToClipboard("x")).resolves.toBe(false);
  });

  /**
   * Régua anti-regressão (mesmo padrão da de crypto.randomUUID): código
   * CLIENT-SIDE não pode chamar navigator.clipboard cru — em http://IP é
   * TypeError no clique do botão "copiar". Sempre via lib/clipboard.ts.
   */
  it('nenhum arquivo "use client" usa navigator.clipboard cru', () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
          if (p.endsWith(join("lib", "clipboard.ts"))) continue; // o próprio helper
          const src = readFileSync(p, "utf8");
          const isClient = src.slice(0, 200).includes('"use client"');
          if (isClient && /navigator\.clipboard/.test(src)) offenders.push(p);
        }
      }
    };
    for (const d of ["app", "components", "hooks", "lib"]) walk(join(root, d));
    expect(offenders).toEqual([]);
  });
});

/**
 * Família #2580 — "Endereço da fonte" em Webhooks: painel modal (Sheet/Dialog)
 * com focus trap. O fallback precisa nascer DENTRO da árvore do diálogo e
 * focar o textarea antes de selecionar, senão o execCommand copia nada.
 */
describe("copyToClipboard — fallback dentro de painel modal com focus trap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** Monta a tela: um dialog role=dialog com o botão copiar dentro (foco nele, como o trap faz). */
  function montaDialogo(): HTMLElement {
    document.body.innerHTML = `
      <div id="fora"><button id="fora-botao">copiar fora</button></div>
      <div role="dialog" aria-modal="true" id="dialogo">
        <button id="copiar">Copiar</button>
      </div>`;
    (document.querySelector("#copiar") as HTMLButtonElement).focus();
    return document.querySelector("#dialogo") as HTMLElement;
  }

  it("com diálogo aberto o textarea nasce DENTRO do diálogo e o copy roda com ele anexado", async () => {
    const dialogo = montaDialogo();
    vi.stubGlobal("navigator", {}); // sem Clipboard API — cai direto no fallback
    let textareaDentroDoDialogo = false;
    document.execCommand = vi.fn(() => {
      textareaDentroDoDialogo = dialogo.querySelector("textarea") !== null;
      return true;
    });
    await expect(copyToClipboard("https://hooks.exemplo.com/f/abc")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(textareaDentroDoDialogo).toBe(true);
    // o helper limpa depois: nada de textarea vazando dentro do diálogo
    expect(dialogo.querySelector("textarea")).toBeNull();
  });

  it("o textarea do fallback chama focus() ANTES de select()", async () => {
    montaDialogo();
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(true);
    const focar = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    const selecionar = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    await copyToClipboard("abc");
    expect(focar).toHaveBeenCalledTimes(1);
    expect(selecionar).toHaveBeenCalledTimes(1);
    expect(focar.mock.invocationCallOrder[0]!).toBeLessThan(
      selecionar.mock.invocationCallOrder[0]!,
    );
  });

  it("SEM diálogo aberto continua anexando em document.body (demais call sites)", async () => {
    document.body.innerHTML = `<button id="soltinho">copiar</button>`;
    (document.querySelector("#soltinho") as HTMLButtonElement).focus();
    vi.stubGlobal("navigator", {});
    let textareaNoBody = false;
    document.execCommand = vi.fn(() => {
      textareaNoBody = document.querySelector("body > textarea") !== null;
      return true;
    });
    await expect(copyToClipboard("abc")).resolves.toBe(true);
    expect(textareaNoBody).toBe(true);
  });

  it("o foco volta ao botão depois da cópia, DENTRO do diálogo", async () => {
    montaDialogo();
    const botao = document.querySelector("#copiar") as HTMLButtonElement;
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(true);
    await copyToClipboard("abc");
    expect(document.activeElement).toBe(botao);
  });

  it("o foco volta ao botão depois da cópia, SEM diálogo aberto", async () => {
    document.body.innerHTML = `<button id="soltinho">copiar</button>`;
    const botao = document.querySelector("#soltinho") as HTMLButtonElement;
    botao.focus();
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(true);
    await copyToClipboard("abc");
    expect(document.activeElement).toBe(botao);
  });
});
