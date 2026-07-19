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
