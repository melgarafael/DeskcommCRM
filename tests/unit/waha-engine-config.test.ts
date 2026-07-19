/**
 * Régua anti-regressão: os compose files DEVEM configurar a engine do WAHA via
 * `WHATSAPP_DEFAULT_ENGINE` (o nome que o WAHA lê) — NUNCA `WAHA_DEFAULT_ENGINE`,
 * que não existe no WAHA e cai silenciosamente no default WEBJS (engine com
 * browser que trava/corrompe a sessão quando o WhatsApp Web atualiza — bug
 * clássico #1386/refreshQR/detached Frame). O self-host tem que nascer em NOWEB.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.prod.yml"];

describe("WAHA engine config (self-host)", () => {
  for (const file of COMPOSE_FILES) {
    const content = readFileSync(path.resolve(__dirname, "../../", file), "utf8");

    it(`${file}: usa WHATSAPP_DEFAULT_ENGINE (nome que o WAHA lê)`, () => {
      expect(content).toMatch(/WHATSAPP_DEFAULT_ENGINE:/);
    });

    it(`${file}: NÃO usa WAHA_DEFAULT_ENGINE (nome errado → cai no WEBJS)`, () => {
      // ignora comentários que mencionam o nome errado ao explicá-lo
      const activeLines = content
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"));
      expect(activeLines.join("\n")).not.toMatch(/WAHA_DEFAULT_ENGINE:/);
    });

    it(`${file}: default da engine é NOWEB (estável, sem browser)`, () => {
      expect(content).toMatch(/WHATSAPP_DEFAULT_ENGINE:\s*(\$\{WHATSAPP_DEFAULT_ENGINE:-NOWEB\}|NOWEB)/);
    });
  }
});
