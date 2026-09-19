// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const componente = fs.readFileSync(
  path.join(process.cwd(), "app/app/ai/agents/[id]/_components/AjustesDeEstilo.tsx"),
  "utf8",
);
const painel = fs.readFileSync(
  path.join(process.cwd(), "app/app/ai/agents/[id]/_components/PainelDeSeguranca.tsx"),
  "utf8",
);

describe("ajuste determinístico de estilo na tela", () => {
  it("mostra o primeiro item da lista fechada como toggle — → ,", () => {
    expect(componente).toContain('data-testid="ajuste-sem-travessao-longo"');
    expect(componente).toContain("— → ,");
    expect(componente).toContain('checked={ligado}');
    expect(componente).toContain('ajuste: "sem_travessao_longo", enabled');
  });

  it("não oferece campo livre de localizar/substituir", () => {
    // Comentário de doc não é UI: a guarda varre o CÓDIGO, não a prosa do header.
    const codigo = componente
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codigo).not.toMatch(/<Input|<Textarea/);
    expect(codigo).not.toMatch(/regex|pattern|localizar|substituir/i);
  });

  it("aparece antes das conferências de saída, como no runtime", () => {
    const ajuste = painel.indexOf("<AjustesDeEstilo />");
    const conferencias = painel.indexOf("CONFERENCIAS_DE_SAIDA.map");
    expect(ajuste).toBeGreaterThan(-1);
    expect(conferencias).toBeGreaterThan(ajuste);
  });
});
