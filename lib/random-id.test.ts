import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "./random-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Achado nº 9 (VPS): crypto.randomUUID não existe em http://IP (non-secure context). */
describe("randomId — UUID v4 dentro E fora de secure context", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("com crypto.randomUUID disponível → delega", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it("SEM crypto.randomUUID (contexto não-seguro) → v4 válido via getRandomValues", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      // randomUUID ausente — exatamente o browser em http://IP
    });
    for (let i = 0; i < 50; i++) expect(randomId()).toMatch(UUID_V4);
  });

  /**
   * Régua anti-regressão: código CLIENT-SIDE não pode chamar
   * crypto.randomUUID() cru — em http://IP isso é TypeError antes do fetch.
   * Varre todo arquivo com "use client" + o apiClient (entrada compartilhada).
   */
  it('nenhum arquivo "use client" (nem lib/api/client.ts) usa crypto.randomUUID cru', () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
          const src = readFileSync(p, "utf8");
          const isClient =
            src.slice(0, 200).includes('"use client"') || p.endsWith("lib/api/client.ts");
          if (isClient && /crypto\.randomUUID\(/.test(src)) offenders.push(p);
        }
      }
    };
    for (const d of ["app", "components", "hooks", "lib"]) walk(join(root, d));
    expect(offenders).toEqual([]);
  });
});
