import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

const ARQUIVO = path.join(process.cwd(), "components/ai/AgentEditor.tsx");

const ROTULOS_EM_INGLES_REMOVIDOS = [
  "Temperature (0–2)",
  "Max tokens (64–4096)",
  "Top K (1–20)",
  "Similarity threshold (0–1)",
] as const;

const CHAVES_TRADUZIDAS = [
  "Temperatura (0–2)",
  "Máximo de tokens (64–4096)",
  "Trechos buscados (1–20)",
  "Limiar de semelhança (0–1)",
] as const;

describe("editor do agente de voz fala o idioma (#5251)", () => {
  const codigo = readFileSync(ARQUIVO, "utf8");

  it.each(ROTULOS_EM_INGLES_REMOVIDOS)(
    "não deixa o rótulo em inglês %s solto dentro de <Label>",
    (rotuloEmIngles) => {
      expect(codigo).not.toContain(`<Label>${rotuloEmIngles}</Label>`);
    },
  );

  it.each(CHAVES_TRADUZIDAS)(
    "passa %s por t(...) no editor e entrega tradução em espanhol no dicionário",
    (chave) => {
      expect(codigo).toContain(`t("${chave}")`);
      const entrada = DICIONARIO[chave as keyof typeof DICIONARIO];
      expect(entrada, `faltou "${chave}" em DICIONARIO`).toBeDefined();
      expect(entrada?.es?.trim().length).toBeGreaterThan(0);
    },
  );
});
