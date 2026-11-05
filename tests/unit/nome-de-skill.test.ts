import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nomeDeSkillValido } from "@/lib/skills/nome-de-skill";

const RAIZ = process.cwd();
const ROTAS = [
  "app/api/v1/ai/skills/[name]/route.ts",
  "app/api/v1/ai/skills/[name]/install/route.ts",
  "app/api/v1/ai/skills/[name]/restore/route.ts",
  "app/api/v1/ai/skills/[name]/versions/route.ts",
];

describe("nome de skill (kebab-case) — a regra mora fora do schema congelado do módulo", () => {
  it("aceita os nomes do catálogo e recusa o que sai da classe", () => {
    for (const bom of ["objecao-preco", "agendamento", "a", "a1-b2", "x".repeat(120)]) {
      expect(nomeDeSkillValido(bom), bom).toBe(true);
    }
    for (const ruim of ["", "-x", "Maiuscula", "com_underscore", "../etc", "a/b", "a b", "a%2Fb", "x".repeat(121)]) {
      expect(nomeDeSkillValido(ruim), ruim).toBe(false);
    }
  });

  // Se alguém tirar a checagem de uma rota, o regex some sem que o contrato congelado note
  // (o nameSchema voltou ao texto original). Esta cerca é o que o substitui.
  it.each(ROTAS)("%s aplica a regra depois do safeParse", (rota) => {
    const fonte = readFileSync(join(RAIZ, rota), "utf8");
    const usos = fonte.match(/nameSchema\.safeParse\(/g)?.length ?? 0;
    const checagens = fonte.match(/!nomeDeSkillValido\(nameParsed\.data\)/g)?.length ?? 0;
    expect(usos).toBeGreaterThan(0);
    expect(checagens).toBe(usos);
  });
});
