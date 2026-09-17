import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const UNIT = join(RAIZ, "tests", "unit");
const IMPORT_COMPARTILHADO = '@/tests/helpers/duble-do-handler';

/**
 * Dívida já existente quando o helper nasceu. A lista só pode ENCOLHER.
 *
 * Cada migração remove um nome daqui. Um arquivo novo nunca entra: se um sexto
 * teste de `sendMessageHandler` inventar outro `makeSupabase`, este gate falha e
 * aponta para o helper compartilhado.
 */
const DUBLES_LEGADOS = new Set([
  "messages-handler-desfechos.test.ts",
  "messages-handler-eco-duplicado.test.ts",
  "messages-handler-silencio-ia-apos-humano.test.ts",
  "messages-handler-canal-intermediado.test.ts",
]);

function arquivosUnitarios(): string[] {
  return readdirSync(UNIT)
    .filter((nome) => nome.endsWith(".test.ts") || nome.endsWith(".test.tsx"))
    .sort();
}

function temDubleLocal(src: string): boolean {
  return /function\s+makeSupabase\s*\(/.test(src) || /const\s+makeSupabase\s*=/.test(src);
}

describe("sendMessageHandler usa um dublê compartilhado", () => {
  it("nenhum teste novo cria outro makeSupabase local", () => {
    const novos: string[] = [];

    for (const nome of arquivosUnitarios()) {
      const src = readFileSync(join(UNIT, nome), "utf8");
      if (!src.includes("sendMessageHandler") || !temDubleLocal(src)) continue;
      if (!DUBLES_LEGADOS.has(nome)) novos.push(nome);
    }

    expect(
      novos,
      `Novo dublê local de sendMessageHandler: ${novos.join(", ")}. ` +
        "Use tests/helpers/duble-do-handler.ts; a lista de legados só encolhe.",
    ).toEqual([]);
  });

  it("cada exceção legada ainda existe — ao migrar, remova também da allowlist", () => {
    const quitados = [...DUBLES_LEGADOS].filter((nome) => {
      const src = readFileSync(join(UNIT, nome), "utf8");
      return !src.includes("sendMessageHandler") || !temDubleLocal(src);
    });

    expect(
      quitados,
      `Dívida já quitada mas ainda permitida: ${quitados.join(", ")}. Remova da allowlist.`,
    ).toEqual([]);
  });

  it("a primeira migração usa o helper de verdade", () => {
    const src = readFileSync(join(UNIT, "inbox-unread-send.test.ts"), "utf8");
    expect(src).toContain(IMPORT_COMPARTILHADO);
    expect(temDubleLocal(src)).toBe(false);
  });
});
