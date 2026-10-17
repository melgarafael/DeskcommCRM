import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Teste de tradução: todas as ocorrências de "agent" em mensagens de usuário
 * devem estar traduzidas para "agente" em português brasileiro.
 *
 * @see issue #2997
 */
describe("Tradução agent → agente", () => {
  const agentsDir = resolve(__dirname, "../../app/app/ai/agents");

  describe("AgentRowMenu.tsx", () => {
    const menuPath = resolve(agentsDir, "_components/AgentRowMenu.tsx");
    const content = readFileSync(menuPath, "utf-8");

    it('deve traduzir "O agent padrão" → "O agente padrão"', () => {
      // Usa espaço+pontuação para distinguir de "agente"
      expect(content).toContain("O agente padrão da organização não pode ser arquivado.");
      expect(content).not.toContain("O agent padrão");
    });

    it('deve traduzir "Agent duplicado" → "Agente duplicado"', () => {
      expect(content).toContain("Agente duplicado.");
      expect(content).not.toContain("Agent duplicado");
    });

    it('deve traduzir "Agent reativado" → "Agente reativado"', () => {
      expect(content).toContain("Agente reativado.");
      expect(content).not.toContain("Agent reativado");
    });

    it('deve traduzir "Agent pausado" → "Agente pausado"', () => {
      expect(content).toContain("Agente pausado.");
      expect(content).not.toContain("Agent pausado");
    });

    it('deve traduzir "Agent arquivado" → "Agente arquivado"', () => {
      expect(content).toContain("Agente arquivado.");
      expect(content).not.toContain("Agent arquivado");
    });

    it('deve traduzir "O agent deixa de responder" → "O agente deixa de responder"', () => {
      expect(content).toContain("O agente deixa de responder gatilhos e some das listas ativas.");
      expect(content).not.toContain("O agent deixa de responder");
    });
  });

  describe("RenameAgentDialog.tsx", () => {
    const dialogPath = resolve(agentsDir, "_components/RenameAgentDialog.tsx");
    const content = readFileSync(dialogPath, "utf-8");

    it('deve traduzir "Renomear agent" → "Renomear agente"', () => {
      // Busca a string exata com aspas para não confundir com "agente"
      expect(content).toContain('t("Renomear agente")');
      expect(content).not.toContain('t("Renomear agent")');
    });
  });

  describe("AgentsListFilters.tsx", () => {
    const filtersPath = resolve(agentsDir, "_components/AgentsListFilters.tsx");
    const content = readFileSync(filtersPath, "utf-8");

    it('deve traduzir "Buscar agents" → "Buscar agentes"', () => {
      // "agents" (inglês) não aparece em "agentes" (português)
      expect(content).toContain("Buscar agentes");
      expect(content).not.toContain("Buscar agents");
    });
  });

  describe("AgentForm.tsx", () => {
    const formPath = resolve(agentsDir, "[id]/_components/AgentForm.tsx");
    const content = readFileSync(formPath, "utf-8");

    it('deve traduzir "Salve o agent" → "Salve o agente"', () => {
      expect(content).toContain("Salve o agente antes de publicar.");
      expect(content).not.toContain("Salve o agent antes");
    });
  });

  describe("Sabotage detection", () => {
    it("deve falhar se qualquer string não-traduzida for reintroduzida", () => {
      // Strings ruins com delimitadores únicos que NÃO são substring das boas
      const badPatterns = [
        "O agent padrão", // "O agent " (espaço depois) — não aparece em "O agente "
        "Agent duplicado", // "Agent " (maiúsculo + espaço) — não aparece em "Agente "
        "Agent reativado",
        "Agent pausado",
        "Agent arquivado",
        "O agent deixa de responder",
        't("Renomear agent")', // aspas de fechamento distinguem de "agente"
        "Buscar agents", // "agents" não é substring de "agentes"
        "Salve o agent antes", // "agent " (espaço) vs "agente "
      ];

      const files = [
        resolve(agentsDir, "_components/AgentRowMenu.tsx"),
        resolve(agentsDir, "_components/RenameAgentDialog.tsx"),
        resolve(agentsDir, "_components/AgentsListFilters.tsx"),
        resolve(agentsDir, "[id]/_components/AgentForm.tsx"),
      ];

      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        for (const bad of badPatterns) {
          expect(content, `${file} não deve conter "${bad}"`).not.toContain(bad);
        }
      }
    });
  });
});
